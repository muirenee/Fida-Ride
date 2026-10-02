package loadtest

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

var (
	driverCount       = flag.Int("drivers", 100, "concurrent virtual drivers")
	riderCount        = flag.Int("riders", 20, "concurrent virtual riders")
	testDuration      = flag.Duration("duration", 60*time.Second, "load duration")
	telemetryInterval = flag.Duration("telemetry-interval", 3*time.Second, "GPS interval")
	rideInterval      = flag.Duration("ride-interval", 2*time.Second, "ride request interval")
	reportInterval    = flag.Duration("report-interval", 5*time.Second, "report interval")
	offerWait         = flag.Duration("offer-wait", 2*time.Second, "counter-offer wait")
	bidsPerRide       = flag.Int("bids-per-ride", 4, "bids generated per ride")
	acceptRacers      = flag.Int("accept-racers", 2, "parallel accept attempts")
	fixturePath       = flag.String("fixtures", "fixtures.json", "credential fixture")
	telemetryURL      = flag.String("telemetry-url", "ws://127.0.0.1:8080/ws/driver", "driver WS URL")
	riderURL          = flag.String("rider-ws-url", "ws://127.0.0.1:8080/ws/rider", "rider WS URL")
	apiBaseURL        = flag.String("api-url", "http://127.0.0.1:3000/api/v1", "NestJS base URL")
	redisAddr         = flag.String("redis-addr", "127.0.0.1:6379", "Redis address")
	redisPassword     = flag.String("redis-password", "", "Redis password")
	baseLat           = flag.Float64("base-lat", -1.9441, "simulation center latitude")
	baseLng           = flag.Float64("base-lng", 30.0619, "simulation center longitude")
)

const dispatchChannel = "ride:dispatch:requested"

type DriverCredential struct {
	DriverID   string
	JWT        string
	SessionID  string
	SessionKey string
}

type RiderCredential struct {
	RiderID string
	JWT     string
}

type Fixture struct {
	Drivers []DriverCredential
	Riders  []RiderCredential
}

type TelemetryPacket struct {
	DriverID  string
	Latitude  float64
	Longitude float64
	Bearing   float64
	Status    string
	SessionID string
	Timestamp int64
	Sequence  int64
	Signature string
}

func (p TelemetryPacket) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{
		"driver_id": p.DriverID, "latitude": p.Latitude, "longitude": p.Longitude,
		"bearing": p.Bearing, "status": p.Status, "session_id": p.SessionID,
		"timestamp": p.Timestamp, "sequence": p.Sequence, "signature": p.Signature,
	})
}

type Metrics struct {
	activeWS          atomic.Int64
	packets           atomic.Uint64
	droppedWS         atomic.Uint64
	wsRTTNanos        atomic.Uint64
	wsRTTCount        atomic.Uint64
	httpTotal         atomic.Uint64
	httpErrors        atomic.Uint64
	expectedConflicts atomic.Uint64
	ridesOK           atomic.Uint64
	bidsOK            atomic.Uint64
	acceptsOK         atomic.Uint64
}

type Harness struct {
	metrics     Metrics
	client      *http.Client
	redis       *redis.Client
	driversByID map[string]DriverCredential
	bidSem      chan struct{}
}

func TestLoad(t *testing.T) {
	if os.Getenv("FIDA_LOADTEST_ENABLE") != "1" {
		t.Skip("set FIDA_LOADTEST_ENABLE=1")
	}
	if *driverCount <= 0 || *riderCount <= 0 || *testDuration <= 0 {
		t.Fatal("drivers, riders and duration must be positive")
	}

	fixture, err := readFixture(*fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(fixture.Drivers) < *driverCount || len(fixture.Riders) < *riderCount {
		t.Fatalf("fixture too small: have %d drivers/%d riders", len(fixture.Drivers), len(fixture.Riders))
	}

	h := newHarness(fixture)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, *testDuration)
	defer cancel()

	if err := h.redis.Ping(ctx).Err(); err != nil {
		t.Fatalf("redis unavailable: %v", err)
	}
	defer h.redis.Close()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); h.reporter(ctx) }()
	go func() { defer wg.Done(); h.dispatchBidder(ctx) }()

	for i := 0; i < *driverCount; i++ {
		cred := fixture.Drivers[i]
		wg.Add(1)
		go func(index int) { defer wg.Done(); h.driverWorker(ctx, index, cred) }(i)
	}

	select {
	case <-ctx.Done():
		wg.Wait()
		return
	case <-time.After(2 * time.Second):
	}

	for i := 0; i < *riderCount; i++ {
		cred := fixture.Riders[i]
		wg.Add(1)
		go func(index int) { defer wg.Done(); h.riderWorker(ctx, index, cred) }(i)
	}

	<-ctx.Done()
	wg.Wait()
	h.printReport("FINAL")
}

func readFixture(path string) (Fixture, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Fixture{}, err
	}
	var fixture Fixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		return Fixture{}, err
	}
	for _, d := range fixture.Drivers {
		key, err := base64.StdEncoding.DecodeString(d.SessionKey)
		if err != nil || len(key) != sha256.Size || d.DriverID == "" || d.JWT == "" || d.SessionID == "" {
			return Fixture{}, errors.New("invalid driver fixture")
		}
	}
	for _, r := range fixture.Riders {
		if r.RiderID == "" || r.JWT == "" {
			return Fixture{}, errors.New("invalid rider fixture")
		}
	}
	return fixture, nil
}

func newHarness(f Fixture) *Harness {
	transport := &http.Transport{
		MaxIdleConns: 10000, MaxIdleConnsPerHost: 10000, MaxConnsPerHost: 10000,
		IdleConnTimeout: 90 * time.Second, DisableCompression: true, ForceAttemptHTTP2: true,
	}
	drivers := make(map[string]DriverCredential, len(f.Drivers))
	for _, d := range f.Drivers {
		drivers[d.DriverID] = d
	}
	return &Harness{
		client: &http.Client{Transport: transport, Timeout: 8 * time.Second},
		redis: redis.NewClient(&redis.Options{
			Addr: *redisAddr, Password: *redisPassword, PoolSize: 128,
			MinIdleConns: 8, DialTimeout: 2 * time.Second, ReadTimeout: 2 * time.Second, WriteTimeout: 2 * time.Second,
		}),
		driversByID: drivers,
		bidSem:      make(chan struct{}, 256),
	}
}

func (h *Harness) driverWorker(ctx context.Context, index int, cred DriverCredential) {
	key, _ := base64.StdEncoding.DecodeString(cred.SessionKey)
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+cred.JWT)
	conn, resp, err := (&websocket.Dialer{HandshakeTimeout: 5 * time.Second}).DialContext(ctx, *telemetryURL, headers)
	if err != nil {
		if resp != nil { _ = resp.Body.Close() }
		h.metrics.droppedWS.Add(1)
		return
	}
	defer conn.Close()
	h.metrics.activeWS.Add(1)
	defer h.metrics.activeWS.Add(-1)

	readErr := make(chan error, 1)
	conn.SetPongHandler(func(payload string) error {
		ns, err := strconv.ParseInt(payload, 10, 64)
		if err == nil {
			d := time.Since(time.Unix(0, ns))
			h.metrics.wsRTTNanos.Add(uint64(d))
			h.metrics.wsRTTCount.Add(1)
		}
		return nil
	})
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				select { case readErr <- err: default: }
				return
			}
		}
	}()

	lat := *baseLat + float64(index/50)*0.00005
	lng := *baseLng + float64(index%50)*0.00005
	bearing := math.Mod(float64(index*11), 360)
	var seq int64
	gps := time.NewTicker(*telemetryInterval)
	ping := time.NewTicker(5 * time.Second)
	defer gps.Stop()
	defer ping.Stop()

	send := func() error {
		seq++
		lat += 0.00002
		lng += 0.000015
		bearing = math.Mod(bearing+2, 360)
		p := TelemetryPacket{
			DriverID: cred.DriverID, Latitude: lat, Longitude: lng, Bearing: bearing,
			Status: "available", SessionID: cred.SessionID, Timestamp: time.Now().UnixMilli(), Sequence: seq,
		}
		p.Signature = sign(key, p)
		_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if err := conn.WriteJSON(p); err != nil { return err }
		h.metrics.packets.Add(1)
		return nil
	}

	if err := send(); err != nil {
		h.metrics.droppedWS.Add(1)
		return
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-gps.C:
			if err := send(); err != nil { h.metrics.droppedWS.Add(1); return }
		case <-ping.C:
			payload := []byte(strconv.FormatInt(time.Now().UnixNano(), 10))
			if err := conn.WriteControl(websocket.PingMessage, payload, time.Now().Add(time.Second)); err != nil {
				h.metrics.droppedWS.Add(1)
				return
			}
		case <-readErr:
			h.metrics.droppedWS.Add(1)
			return
		}
	}
}

func sign(key []byte, p TelemetryPacket) string {
	canonical := strings.Join([]string{
		"v1", p.SessionID, p.DriverID,
		strconv.FormatFloat(p.Latitude, 'f', 7, 64),
		strconv.FormatFloat(p.Longitude, 'f', 7, 64),
		strconv.FormatFloat(p.Bearing, 'f', 2, 64),
		p.Status, strconv.FormatInt(p.Timestamp, 10), strconv.FormatInt(p.Sequence, 10),
	}, "\n")
	m := hmac.New(sha256.New, key)
	_, _ = m.Write([]byte(canonical))
	return hex.EncodeToString(m.Sum(nil))
}

func (h *Harness) dispatchBidder(ctx context.Context) {
	ps := h.redis.Subscribe(ctx, dispatchChannel)
	defer ps.Close()
	if _, err := ps.Receive(ctx); err != nil { return }
	ch := ps.Channel(redis.WithChannelSize(4096))

	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok { return }
			var event map[string]any
			if json.Unmarshal([]byte(msg.Payload), &event) != nil { continue }
			tripID, _ := event["trip_id"].(string)
			rawCandidates, _ := event["candidate_driver_ids"].([]any)
			if tripID == "" || len(rawCandidates) == 0 { continue }

			limit := *bidsPerRide
			if limit > len(rawCandidates) { limit = len(rawCandidates) }
			for i := 0; i < limit; i++ {
				id, _ := rawCandidates[i].(string)
				driver, ok := h.driversByID[id]
				if !ok { continue }
				fare := 3500 + float64(i*150)
				select {
				case <-ctx.Done():
					return
				case h.bidSem <- struct{}{}:
				}
				go func(d DriverCredential, amount float64) {
					defer func() { <-h.bidSem }()
					status, err := h.post(ctx, "/bidding/negotiate", d.JWT, map[string]any{
						"trip_id": tripID, "driver_id": d.DriverID, "proposed_fare": amount,
					}, nil)
					if err == nil && status >= 200 && status < 300 { h.metrics.bidsOK.Add(1) }
				}(driver, fare)
			}
		}
	}
}

func (h *Harness) riderWorker(ctx context.Context, index int, cred RiderCredential) {
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+cred.JWT)
	conn, resp, err := (&websocket.Dialer{HandshakeTimeout: 5 * time.Second}).DialContext(ctx, *riderURL, headers)
	if err != nil {
		if resp != nil { _ = resp.Body.Close() }
		h.metrics.droppedWS.Add(1)
		return
	}
	defer conn.Close()
	h.metrics.activeWS.Add(1)
	defer h.metrics.activeWS.Add(-1)

	offers := make(chan map[string]any, 256)
	readErr := make(chan error, 1)
	go func() {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				select { case readErr <- err: default: }
				return
			}
			var event map[string]any
			if json.Unmarshal(raw, &event) == nil && event["event"] == "counter_offer_received" {
				select { case offers <- event: default: }
			}
		}
	}()

	rng := rand.New(rand.NewSource(int64(index + 1)))
	ticker := time.NewTicker(*rideInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-readErr:
			h.metrics.droppedWS.Add(1)
			return
		case <-ticker.C:
			plat := *baseLat + (rng.Float64()-0.5)*0.002
			plng := *baseLng + (rng.Float64()-0.5)*0.002
			var response map[string]any
			status, err := h.post(ctx, "/rides/request", cred.JWT, map[string]any{
				"rider_id": cred.RiderID, "pickup_lat": plat, "pickup_lng": plng,
				"dropoff_lat": plat + 0.012, "dropoff_lng": plng + 0.012,
				"vehicle_type": "taxi", "payment_method": "cash",
			}, &response)
			if err != nil || status < 200 || status >= 300 { continue }
			tripID, _ := response["trip_id"].(string)
			if tripID == "" { continue }
			h.metrics.ridesOK.Add(1)

			accepted := h.collectAndRace(ctx, cred.JWT, tripID, offers)
			if accepted { h.metrics.acceptsOK.Add(1) }
		}
	}
}

func (h *Harness) collectAndRace(ctx context.Context, jwt, tripID string, offers <-chan map[string]any) bool {
	timer := time.NewTimer(*offerWait)
	defer timer.Stop()
	drivers := make([]string, 0, *bidsPerRide)

	for len(drivers) < *bidsPerRide {
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			goto race
		case offer := <-offers:
			if offer["trip_id"] != tripID { continue }
			id, _ := offer["driver_id"].(string)
			if id != "" { drivers = append(drivers, id) }
		}
	}

race:
	if len(drivers) == 0 { return false }
	n := *acceptRacers
	if n > len(drivers) { n = len(drivers) }

	var wg sync.WaitGroup
	var success atomic.Bool
	wg.Add(n)
	for i := 0; i < n; i++ {
		driverID := drivers[i]
		go func() {
			defer wg.Done()
			status, err := h.post(ctx, "/bidding/accept", jwt, map[string]any{
				"trip_id": tripID, "driver_id": driverID,
			}, nil)
			if err == nil && status >= 200 && status < 300 { success.Store(true) }
		}()
	}
	wg.Wait()
	return success.Load()
}

func (h *Harness) post(ctx context.Context, path, token string, body any, out *map[string]any) (int, error) {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(*apiBaseURL, "/")+path, bytes.NewReader(raw))
	if err != nil { return 0, err }
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.metrics.httpTotal.Add(1)

	resp, err := h.client.Do(req)
	if err != nil {
		h.metrics.httpErrors.Add(1)
		return 0, err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 32768))
	if err != nil {
		h.metrics.httpErrors.Add(1)
		return resp.StatusCode, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		h.metrics.httpErrors.Add(1)
		if resp.StatusCode == http.StatusConflict && strings.HasSuffix(path, "/bidding/accept") {
			h.metrics.expectedConflicts.Add(1)
		}
		return resp.StatusCode, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if out != nil && len(payload) > 0 {
		if err := json.Unmarshal(payload, out); err != nil {
			h.metrics.httpErrors.Add(1)
			return resp.StatusCode, err
		}
	}
	return resp.StatusCode, nil
}

func (h *Harness) reporter(ctx context.Context) {
	ticker := time.NewTicker(*reportInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.printReport(time.Now().Format(time.RFC3339))
		}
	}
}

func (h *Harness) printReport(prefix string) {
	count := h.metrics.wsRTTCount.Load()
	var avg time.Duration
	if count > 0 { avg = time.Duration(h.metrics.wsRTTNanos.Load() / count) }
	total := h.metrics.httpTotal.Load()
	var ratio float64
	if total > 0 { ratio = float64(h.metrics.httpErrors.Load()) / float64(total) }
	fmt.Printf("%s active_ws=%d packets=%d dropped_ws=%d ws_avg_rtt=%s http_total=%d http_errors=%d error_ratio=%.4f expected_409=%d rides_ok=%d bids_ok=%d accepts_ok=%d\n",
		prefix, h.metrics.activeWS.Load(), h.metrics.packets.Load(), h.metrics.droppedWS.Load(), avg,
		total, h.metrics.httpErrors.Load(), ratio, h.metrics.expectedConflicts.Load(),
		h.metrics.ridesOK.Load(), h.metrics.bidsOK.Load(), h.metrics.acceptsOK.Load(),
	)
}
