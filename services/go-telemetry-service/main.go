package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

const (
	locationsKey = "drivers:locations"
	lastSeenKey  = "drivers:last_seen"
	updatesChan  = "driver:updates:active"
	presencePref = "driver:presence:"

	maxTelemetryMessageBytes = 4 * 1024
	maxDriverIDLength        = 128
)

var driverIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)

type Config struct {
	Addr                  string
	RedisAddr             string
	RedisPassword         string
	RedisDB               int
	PresenceTTL           time.Duration
	StaleCleanupInterval  time.Duration
	CleanupBatchSize      int64
	ReadTimeout           time.Duration
	WriteTimeout          time.Duration
	IdleConnectionTimeout time.Duration
	PingInterval          time.Duration
	JWTSecret             string
	AllowInsecureDriverID bool
	AllowedOrigins        map[string]struct{}
}

type TelemetryPacket struct {
	DriverID  string  `json:"driver_id"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Bearing   float64 `json:"bearing"`
	Status    string  `json:"status"`
}

type jwtHeader struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
}

type jwtClaims struct {
	Subject   string `json:"sub"`
	DriverID  string `json:"driver_id"`
	Expiry    int64  `json:"exp"`
	NotBefore int64  `json:"nbf"`
}

type Server struct {
	cfg      Config
	redis    *redis.Client
	logger   *slog.Logger
	upgrader websocket.Upgrader

	connMu sync.Mutex
	conns  map[*websocket.Conn]string
}

var cleanupStaleDriversScript = redis.NewScript(`
local stale = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local removed = 0
for _, driverID in ipairs(stale) do
  local score = redis.call('ZSCORE', KEYS[1], driverID)
  if score and tonumber(score) <= tonumber(ARGV[1]) then
    redis.call('ZREM', KEYS[1], driverID)
    redis.call('ZREM', KEYS[2], driverID)
    redis.call('DEL', ARGV[3] .. driverID)
    removed = removed + 1
  end
end
return removed
`)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := loadConfig()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	if _, err := loadTelemetryFraudSettings(); err != nil {
		logger.Error("invalid telemetry fraud configuration", "error", err)
		os.Exit(1)
	}

	if !cfg.AllowInsecureDriverID && cfg.JWTSecret == "" {
		logger.Error("JWT_HS256_SECRET is required when insecure driver_id authentication is disabled")
		os.Exit(1)
	}

	rdb := redis.NewClient(&redis.Options{
		Addr:         cfg.RedisAddr,
		Password:     cfg.RedisPassword,
		DB:           cfg.RedisDB,
		DialTimeout:  3 * time.Second,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		PoolSize:     100,
		MinIdleConns: 10,
	})

	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelStartup()
	if err := rdb.Ping(startupCtx).Err(); err != nil {
		logger.Error("redis unavailable", "address", cfg.RedisAddr, "error", err)
		os.Exit(1)
	}

	s := &Server{
		cfg:    cfg,
		redis:  rdb,
		logger: logger,
		conns:  make(map[*websocket.Conn]string),
	}
	s.upgrader = websocket.Upgrader{
		HandshakeTimeout: 5 * time.Second,
		ReadBufferSize:   1024,
		WriteBufferSize:  1024,
		CheckOrigin:      s.checkOrigin,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.healthHandler)
	mux.HandleFunc("/readyz", s.healthHandler)
	mux.HandleFunc("/ws/driver", s.driverWebSocketHandler)
	mux.HandleFunc("/ws/rider", s.riderWebSocketHandler)

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           recoveryMiddleware(logger, mux),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go s.runStaleDriverJanitor(ctx)
	go s.runBiddingEventSubscriber(ctx)
	go s.runSecurityDisconnectSubscriber(ctx)

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("telemetry service started",
			"addr", cfg.Addr,
			"redis_addr", cfg.RedisAddr,
			"presence_ttl", cfg.PresenceTTL.String(),
			"insecure_driver_id_enabled", cfg.AllowInsecureDriverID,
		)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutdown signal received")
	case err := <-serverErr:
		logger.Error("http server failed", "error", err)
		stop()
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()

	s.closeAllConnections("server shutting down")
	s.closeAllRiderConnections("server shutting down")
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("http server shutdown failed", "error", err)
	}
	if err := rdb.Close(); err != nil {
		logger.Error("redis close failed", "error", err)
	}

	logger.Info("telemetry service stopped")
}

func loadConfig() (Config, error) {
	redisDB, err := envInt("REDIS_DB", 0)
	if err != nil {
		return Config{}, err
	}
	cleanupBatchSize, err := envInt64("STALE_CLEANUP_BATCH_SIZE", 5000)
	if err != nil {
		return Config{}, err
	}

	presenceTTL, err := envDuration("DRIVER_PRESENCE_TTL", 20*time.Second)
	if err != nil {
		return Config{}, err
	}
	cleanupInterval, err := envDuration("STALE_CLEANUP_INTERVAL", 5*time.Second)
	if err != nil {
		return Config{}, err
	}
	idleTimeout, err := envDuration("WS_IDLE_TIMEOUT", 60*time.Second)
	if err != nil {
		return Config{}, err
	}
	pingInterval, err := envDuration("WS_PING_INTERVAL", 25*time.Second)
	if err != nil {
		return Config{}, err
	}

	allowInsecure, err := strconv.ParseBool(env("ALLOW_INSECURE_DRIVER_ID", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("ALLOW_INSECURE_DRIVER_ID: %w", err)
	}

	cfg := Config{
		Addr:                  env("HTTP_ADDR", ":8080"),
		RedisAddr:             env("REDIS_ADDR", "redis:6379"),
		RedisPassword:         os.Getenv("REDIS_PASSWORD"),
		RedisDB:               redisDB,
		PresenceTTL:           presenceTTL,
		StaleCleanupInterval:  cleanupInterval,
		CleanupBatchSize:      cleanupBatchSize,
		ReadTimeout:           2 * time.Second,
		WriteTimeout:          2 * time.Second,
		IdleConnectionTimeout: idleTimeout,
		PingInterval:          pingInterval,
		JWTSecret:             os.Getenv("JWT_HS256_SECRET"),
		AllowInsecureDriverID: allowInsecure,
		AllowedOrigins:        parseOrigins(os.Getenv("WS_ALLOWED_ORIGINS")),
	}

	if cfg.PresenceTTL <= 0 {
		return Config{}, errors.New("DRIVER_PRESENCE_TTL must be positive")
	}
	if cfg.StaleCleanupInterval <= 0 {
		return Config{}, errors.New("STALE_CLEANUP_INTERVAL must be positive")
	}
	if cfg.CleanupBatchSize <= 0 {
		return Config{}, errors.New("STALE_CLEANUP_BATCH_SIZE must be positive")
	}
	if cfg.PingInterval <= 0 || cfg.PingInterval >= cfg.IdleConnectionTimeout {
		return Config{}, errors.New("WS_PING_INTERVAL must be positive and less than WS_IDLE_TIMEOUT")
	}

	return cfg, nil
}

func (s *Server) driverWebSocketHandler(w http.ResponseWriter, r *http.Request) {
	driverID, authMethod, err := s.authenticateDriver(r)
	if err != nil {
		s.logger.Warn("websocket authentication rejected", "remote_ip", clientIP(r), "error", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Warn("websocket upgrade failed", "driver_id", driverID, "remote_ip", clientIP(r), "error", err)
		return
	}
	defer conn.Close()

	s.registerConnection(conn, driverID)
	defer s.unregisterConnection(conn)

	conn.SetReadLimit(maxTelemetryMessageBytes)
	_ = conn.SetReadDeadline(time.Now().Add(s.cfg.IdleConnectionTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(s.cfg.IdleConnectionTimeout))
	})

	done := make(chan struct{})
	go s.pingLoop(conn, driverID, done)
	defer close(done)

	s.logger.Info("driver websocket connected",
		"driver_id", driverID,
		"auth_method", authMethod,
		"remote_ip", clientIP(r),
	)

	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseGoingAway,
				websocket.CloseNormalClosure,
				websocket.CloseNoStatusReceived,
			) {
				s.logger.Warn("driver websocket closed unexpectedly", "driver_id", driverID, "error", err)
			} else {
				s.logger.Info("driver websocket disconnected", "driver_id", driverID)
			}
			return
		}

		_ = conn.SetReadDeadline(time.Now().Add(s.cfg.IdleConnectionTimeout))

		if messageType != websocket.TextMessage && messageType != websocket.BinaryMessage {
			continue
		}

		packet, err := decodeTelemetry(payload)
		if err != nil {
			s.logger.Warn("telemetry packet rejected", "driver_id", driverID, "error", err)
			continue
		}
		if packet.DriverID != driverID {
			s.logger.Warn("telemetry driver identity mismatch",
				"authenticated_driver_id", driverID,
				"packet_driver_id", packet.DriverID,
			)
			_ = writeClose(conn, websocket.ClosePolicyViolation, "driver identity mismatch")
			return
		}

		verdict, err := s.validateTelemetryVelocity(packet)
		if err != nil {
			s.logger.Error("telemetry fraud validation failed", "driver_id", driverID, "error", err)
			continue
		}
		if verdict.Flagged {
			s.logger.Warn(
				"telemetry velocity jump rejected",
				"driver_id", driverID,
				"speed_kph", verdict.SpeedKPH,
				"distance_meters", verdict.DistanceMeters,
				"elapsed_ms", verdict.Elapsed.Milliseconds(),
			)
			if err := s.publishTelemetryVelocityJump(packet, verdict); err != nil {
				s.logger.Error("velocity fraud event publish failed", "driver_id", driverID, "error", err)
			}
			continue
		}

		if err := s.persistAndPublishTelemetry(packet, verdict.ObservedAt, verdict.UpdateTrustedState); err != nil {
			s.logger.Error("telemetry redis pipeline failed", "driver_id", driverID, "error", err)
			continue
		}

		s.logger.Debug("telemetry packet accepted",
			"driver_id", driverID,
			"latitude", packet.Latitude,
			"longitude", packet.Longitude,
			"status", packet.Status,
		)
	}
}

func (s *Server) persistAndPublishTelemetry(
	packet TelemetryPacket,
	observedAt time.Time,
	updateTrustedState bool,
) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	payload, err := json.Marshal(packet)
	if err != nil {
		return fmt.Errorf("marshal telemetry: %w", err)
	}

	pipe := s.redis.Pipeline()
	pipe.GeoAdd(ctx, locationsKey, &redis.GeoLocation{
		Name:      packet.DriverID,
		Longitude: packet.Longitude,
		Latitude:  packet.Latitude,
	})
	pipe.Set(ctx, presencePref+packet.DriverID, packet.Status, s.cfg.PresenceTTL)
	pipe.ZAdd(ctx, lastSeenKey, redis.Z{
		Score:  float64(observedAt.UnixMilli()),
		Member: packet.DriverID,
	})
	if updateTrustedState {
		if err := s.appendTrustedTelemetryState(ctx, pipe, packet, observedAt); err != nil {
			return err
		}
	}
	pipe.Publish(ctx, updatesChan, payload)

	if _, err := pipe.Exec(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Server) authenticateDriver(r *http.Request) (driverID, method string, err error) {
	token := bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	if token != "" {
		if s.cfg.JWTSecret == "" {
			return "", "", errors.New("JWT authentication is not configured")
		}
		driverID, err := validateHS256JWT(token, s.cfg.JWTSecret, time.Now().UTC())
		if err != nil {
			return "", "", fmt.Errorf("invalid JWT: %w", err)
		}
		if err := validateDriverID(driverID); err != nil {
			return "", "", err
		}
		return driverID, "jwt", nil
	}

	if s.cfg.AllowInsecureDriverID {
		driverID := strings.TrimSpace(r.URL.Query().Get("driver_id"))
		if err := validateDriverID(driverID); err != nil {
			return "", "", err
		}
		return driverID, "query_driver_id", nil
	}

	return "", "", errors.New("missing bearer token")
}

func validateHS256JWT(token, secret string, now time.Time) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errors.New("malformed token")
	}

	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", errors.New("invalid JWT header encoding")
	}
	var header jwtHeader
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return "", errors.New("invalid JWT header")
	}
	if header.Algorithm != "HS256" {
		return "", fmt.Errorf("unsupported JWT algorithm %q", header.Algorithm)
	}

	providedSignature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", errors.New("invalid JWT signature encoding")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(providedSignature, mac.Sum(nil)) {
		return "", errors.New("JWT signature mismatch")
	}

	claimsBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", errors.New("invalid JWT claims encoding")
	}
	var claims jwtClaims
	if err := json.Unmarshal(claimsBytes, &claims); err != nil {
		return "", errors.New("invalid JWT claims")
	}

	nowUnix := now.Unix()
	if claims.Expiry == 0 || nowUnix >= claims.Expiry {
		return "", errors.New("JWT expired or missing exp claim")
	}
	if claims.NotBefore != 0 && nowUnix < claims.NotBefore {
		return "", errors.New("JWT not active yet")
	}

	driverID := strings.TrimSpace(claims.Subject)
	if driverID == "" {
		driverID = strings.TrimSpace(claims.DriverID)
	}
	if driverID == "" {
		return "", errors.New("JWT missing sub or driver_id claim")
	}
	return driverID, nil
}

func decodeTelemetry(payload []byte) (TelemetryPacket, error) {
	var packet TelemetryPacket
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&packet); err != nil {
		return TelemetryPacket{}, fmt.Errorf("invalid JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return TelemetryPacket{}, errors.New("multiple JSON values are not allowed")
	}

	packet.DriverID = strings.TrimSpace(packet.DriverID)
	packet.Status = strings.TrimSpace(packet.Status)
	if err := validateDriverID(packet.DriverID); err != nil {
		return TelemetryPacket{}, err
	}
	if packet.Latitude < -90 || packet.Latitude > 90 {
		return TelemetryPacket{}, errors.New("latitude must be between -90 and 90")
	}
	if packet.Longitude < -180 || packet.Longitude > 180 {
		return TelemetryPacket{}, errors.New("longitude must be between -180 and 180")
	}
	if packet.Bearing < 0 || packet.Bearing >= 360 {
		return TelemetryPacket{}, errors.New("bearing must be >= 0 and < 360")
	}
	if packet.Status == "" || len(packet.Status) > 32 {
		return TelemetryPacket{}, errors.New("status is required and must be <= 32 characters")
	}
	return packet, nil
}

func validateDriverID(driverID string) error {
	if driverID == "" {
		return errors.New("driver_id is required")
	}
	if len(driverID) > maxDriverIDLength {
		return fmt.Errorf("driver_id exceeds %d characters", maxDriverIDLength)
	}
	if !driverIDPattern.MatchString(driverID) {
		return errors.New("driver_id contains unsupported characters")
	}
	return nil
}

func (s *Server) runStaleDriverJanitor(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.StaleCleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := time.Now().UTC().Add(-s.cfg.PresenceTTL).UnixMilli()
			for {
				result, err := cleanupStaleDriversScript.Run(
					ctx,
					s.redis,
					[]string{lastSeenKey, locationsKey},
					cutoff,
					s.cfg.CleanupBatchSize,
					presencePref,
				).Int64()
				if err != nil {
					if !errors.Is(err, context.Canceled) {
						s.logger.Error("stale driver cleanup failed", "error", err)
					}
					break
				}
				if result > 0 {
					s.logger.Info("stale drivers removed", "count", result)
				}
				if result < s.cfg.CleanupBatchSize {
					break
				}
			}
		}
	}
}

func (s *Server) pingLoop(conn *websocket.Conn, driverID string, done <-chan struct{}) {
	ticker := time.NewTicker(s.cfg.PingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			deadline := time.Now().Add(3 * time.Second)
			if err := conn.WriteControl(websocket.PingMessage, nil, deadline); err != nil {
				s.logger.Debug("websocket ping failed", "driver_id", driverID, "error", err)
				return
			}
		}
	}
}

func (s *Server) registerConnection(conn *websocket.Conn, driverID string) {
	s.connMu.Lock()
	s.conns[conn] = driverID
	s.connMu.Unlock()
}

func (s *Server) unregisterConnection(conn *websocket.Conn) {
	s.connMu.Lock()
	delete(s.conns, conn)
	s.connMu.Unlock()
}

func (s *Server) closeAllConnections(reason string) {
	s.connMu.Lock()
	connections := make([]*websocket.Conn, 0, len(s.conns))
	for conn := range s.conns {
		connections = append(connections, conn)
	}
	s.connMu.Unlock()

	for _, conn := range connections {
		_ = writeClose(conn, websocket.CloseGoingAway, reason)
		_ = conn.Close()
	}
}

func writeClose(conn *websocket.Conn, code int, reason string) error {
	return conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason),
		time.Now().Add(2*time.Second),
	)
}

func (s *Server) healthHandler(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	if err := s.redis.Ping(ctx).Err(); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unhealthy"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func recoveryMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.Error("panic recovered",
					"panic", fmt.Sprint(recovered),
					"method", r.Method,
					"path", r.URL.Path,
					"remote_ip", clientIP(r),
				)
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) checkOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	if len(s.cfg.AllowedOrigins) > 0 {
		_, ok := s.cfg.AllowedOrigins[origin]
		return ok
	}

	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(parsed.Host, r.Host)
}

func bearerToken(header string) string {
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

func clientIP(r *http.Request) string {
	if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
		if idx := strings.IndexByte(forwarded, ','); idx >= 0 {
			forwarded = forwarded[:idx]
		}
		return strings.TrimSpace(forwarded)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func parseOrigins(value string) map[string]struct{} {
	result := make(map[string]struct{})
	for _, part := range strings.Split(value, ",") {
		origin := strings.TrimSpace(part)
		if origin != "" {
			result[origin] = struct{}{}
		}
	}
	return result
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) (int, error) {
	value := env(key, strconv.Itoa(fallback))
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return parsed, nil
}

func envInt64(key string, fallback int64) (int64, error) {
	value := env(key, strconv.FormatInt(fallback, 10))
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return parsed, nil
}

func envDuration(key string, fallback time.Duration) (time.Duration, error) {
	value := env(key, fallback.String())
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return parsed, nil
}
