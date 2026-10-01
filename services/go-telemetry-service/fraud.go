package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	telemetryFraudStatePrefix = "fraud:telemetry:last:"
	telemetrySecurityChannel  = "security:telemetry-events"
)

var (
	telemetryFraudSettingsOnce  sync.Once
	telemetryFraudSettingsValue telemetryFraudSettings
	telemetryFraudSettingsErr   error
)

type telemetryFraudSettings struct {
	MaxSpeedKPH  float64
	MinWindow    time.Duration
	MaxWindow    time.Duration
	StateTTL     time.Duration
	RedisTimeout time.Duration
	Budget       time.Duration
}

type TelemetryVelocityVerdict struct {
	ObservedAt         time.Time
	UpdateTrustedState bool
	Flagged            bool
	SpeedKPH           float64
	DistanceMeters     float64
	Elapsed            time.Duration
	Previous           *TrustedTelemetryPoint
}

type TrustedTelemetryPoint struct {
	Latitude     float64 `json:"latitude"`
	Longitude    float64 `json:"longitude"`
	ObservedAtMS int64   `json:"observed_at_ms"`
}

type TelemetryVelocityJumpEvent struct {
	Event          string                `json:"event"`
	DriverID       string                `json:"driver_id"`
	SpeedKPH       float64               `json:"speed_kph"`
	DistanceMeters float64               `json:"distance_meters"`
	ElapsedMS      int64                 `json:"elapsed_ms"`
	Previous       TrustedTelemetryPoint `json:"previous"`
	Current        TrustedTelemetryPoint `json:"current"`
	ObservedAt     string                `json:"observed_at"`
}

func loadTelemetryFraudSettings() (telemetryFraudSettings, error) {
	telemetryFraudSettingsOnce.Do(func() {
		telemetryFraudSettingsValue, telemetryFraudSettingsErr = parseTelemetryFraudSettings()
	})
	return telemetryFraudSettingsValue, telemetryFraudSettingsErr
}

func parseTelemetryFraudSettings() (telemetryFraudSettings, error) {
	maxSpeed, err := fraudEnvFloat("TELEMETRY_MAX_SPEED_KPH", 160)
	if err != nil {
		return telemetryFraudSettings{}, err
	}
	minWindow, err := envDuration("TELEMETRY_VELOCITY_MIN_WINDOW", 2*time.Second)
	if err != nil {
		return telemetryFraudSettings{}, err
	}
	maxWindow, err := envDuration("TELEMETRY_VELOCITY_MAX_WINDOW", 90*time.Second)
	if err != nil {
		return telemetryFraudSettings{}, err
	}
	stateTTL, err := envDuration("TELEMETRY_FRAUD_STATE_TTL", 15*time.Minute)
	if err != nil {
		return telemetryFraudSettings{}, err
	}
	redisTimeout, err := envDuration("TELEMETRY_FRAUD_REDIS_TIMEOUT", 100*time.Millisecond)
	if err != nil {
		return telemetryFraudSettings{}, err
	}
	budget, err := envDuration("TELEMETRY_FRAUD_BUDGET", 2*time.Millisecond)
	if err != nil {
		return telemetryFraudSettings{}, err
	}

	if maxSpeed <= 0 {
		return telemetryFraudSettings{}, errors.New("TELEMETRY_MAX_SPEED_KPH must be positive")
	}
	if minWindow <= 0 || maxWindow <= minWindow {
		return telemetryFraudSettings{}, errors.New("telemetry velocity window must satisfy 0 < min < max")
	}
	if stateTTL <= maxWindow {
		return telemetryFraudSettings{}, errors.New("TELEMETRY_FRAUD_STATE_TTL must exceed TELEMETRY_VELOCITY_MAX_WINDOW")
	}
	if redisTimeout <= 0 || budget <= 0 {
		return telemetryFraudSettings{}, errors.New("telemetry fraud timeouts must be positive")
	}

	return telemetryFraudSettings{
		MaxSpeedKPH:  maxSpeed,
		MinWindow:    minWindow,
		MaxWindow:    maxWindow,
		StateTTL:     stateTTL,
		RedisTimeout: redisTimeout,
		Budget:       budget,
	}, nil
}

func (s *Server) validateTelemetryVelocity(packet TelemetryPacket) (TelemetryVelocityVerdict, error) {
	started := time.Now()
	observedAt := time.Now().UTC()
	settings, err := loadTelemetryFraudSettings()
	if err != nil {
		return TelemetryVelocityVerdict{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), settings.RedisTimeout)
	defer cancel()

	values, err := s.redis.HMGet(
		ctx,
		telemetryFraudStatePrefix+packet.DriverID,
		"latitude",
		"longitude",
		"observed_at_ms",
	).Result()
	if err != nil {
		return TelemetryVelocityVerdict{}, fmt.Errorf("read trusted telemetry baseline: %w", err)
	}

	verdict := TelemetryVelocityVerdict{
		ObservedAt:         observedAt,
		UpdateTrustedState: true,
	}

	previous, ok := parseTrustedTelemetryPoint(values)
	if !ok {
		s.logFraudBudget(started, settings.Budget, packet.DriverID)
		return verdict, nil
	}
	verdict.Previous = &previous

	elapsed := observedAt.Sub(time.UnixMilli(previous.ObservedAtMS))
	verdict.Elapsed = elapsed

	if elapsed <= 0 || elapsed < settings.MinWindow {
		verdict.UpdateTrustedState = false
		s.logFraudBudget(started, settings.Budget, packet.DriverID)
		return verdict, nil
	}

	if elapsed > settings.MaxWindow {
		s.logFraudBudget(started, settings.Budget, packet.DriverID)
		return verdict, nil
	}

	distanceMeters := haversineMeters(
		previous.Latitude,
		previous.Longitude,
		packet.Latitude,
		packet.Longitude,
	)
	speedKPH := distanceMeters / elapsed.Seconds() * 3.6

	verdict.DistanceMeters = distanceMeters
	verdict.SpeedKPH = speedKPH

	if speedKPH > settings.MaxSpeedKPH {
		verdict.Flagged = true
		verdict.UpdateTrustedState = false
	}

	s.logFraudBudget(started, settings.Budget, packet.DriverID)
	return verdict, nil
}

func (s *Server) appendTrustedTelemetryState(
	ctx context.Context,
	pipe redis.Pipeliner,
	packet TelemetryPacket,
	observedAt time.Time,
) error {
	settings, err := loadTelemetryFraudSettings()
	if err != nil {
		return err
	}

	key := telemetryFraudStatePrefix + packet.DriverID
	pipe.HSet(ctx, key, map[string]any{
		"latitude":       packet.Latitude,
		"longitude":      packet.Longitude,
		"observed_at_ms": observedAt.UnixMilli(),
	})
	pipe.Expire(ctx, key, settings.StateTTL)
	return nil
}

func (s *Server) publishTelemetryVelocityJump(
	packet TelemetryPacket,
	verdict TelemetryVelocityVerdict,
) error {
	if !verdict.Flagged || verdict.Previous == nil {
		return nil
	}

	current := TrustedTelemetryPoint{
		Latitude:     packet.Latitude,
		Longitude:    packet.Longitude,
		ObservedAtMS: verdict.ObservedAt.UnixMilli(),
	}
	event := TelemetryVelocityJumpEvent{
		Event:          "telemetry_velocity_jump",
		DriverID:       packet.DriverID,
		SpeedKPH:       roundFloat(verdict.SpeedKPH, 2),
		DistanceMeters: roundFloat(verdict.DistanceMeters, 2),
		ElapsedMS:      verdict.Elapsed.Milliseconds(),
		Previous:       *verdict.Previous,
		Current:        current,
		ObservedAt:     verdict.ObservedAt.Format(time.RFC3339Nano),
	}

	payload, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal velocity fraud event: %w", err)
	}

	settings, err := loadTelemetryFraudSettings()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), settings.RedisTimeout)
	defer cancel()

	if err := s.redis.Publish(ctx, telemetrySecurityChannel, payload).Err(); err != nil {
		return fmt.Errorf("publish velocity fraud event: %w", err)
	}
	return nil
}

func haversineMeters(lat1, lon1, lat2, lon2 float64) float64 {
	const earthRadiusMeters = 6371008.8
	phi1 := lat1 * math.Pi / 180
	phi2 := lat2 * math.Pi / 180
	deltaPhi := (lat2 - lat1) * math.Pi / 180
	deltaLambda := (lon2 - lon1) * math.Pi / 180

	a := math.Sin(deltaPhi/2)*math.Sin(deltaPhi/2) +
		math.Cos(phi1)*math.Cos(phi2)*
			math.Sin(deltaLambda/2)*math.Sin(deltaLambda/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return earthRadiusMeters * c
}

func parseTrustedTelemetryPoint(values []any) (TrustedTelemetryPoint, bool) {
	if len(values) != 3 || values[0] == nil || values[1] == nil || values[2] == nil {
		return TrustedTelemetryPoint{}, false
	}
	latitude, err := strconv.ParseFloat(fmt.Sprint(values[0]), 64)
	if err != nil || latitude < -90 || latitude > 90 {
		return TrustedTelemetryPoint{}, false
	}
	longitude, err := strconv.ParseFloat(fmt.Sprint(values[1]), 64)
	if err != nil || longitude < -180 || longitude > 180 {
		return TrustedTelemetryPoint{}, false
	}
	observedAtMS, err := strconv.ParseInt(fmt.Sprint(values[2]), 10, 64)
	if err != nil || observedAtMS <= 0 {
		return TrustedTelemetryPoint{}, false
	}
	return TrustedTelemetryPoint{
		Latitude:     latitude,
		Longitude:    longitude,
		ObservedAtMS: observedAtMS,
	}, true
}

func (s *Server) logFraudBudget(started time.Time, budget time.Duration, driverID string) {
	elapsed := time.Since(started)
	if elapsed > budget {
		s.logger.Debug(
			"telemetry fraud check exceeded target budget",
			"driver_id", driverID,
			"elapsed", elapsed.String(),
			"target", budget.String(),
		)
	}
}

func fraudEnvFloat(key string, fallback float64) (float64, error) {
	value := env(key, strconv.FormatFloat(fallback, 'f', -1, 64))
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, fmt.Errorf("%s must be a finite number", key)
	}
	return parsed, nil
}

func roundFloat(value float64, decimals int) float64 {
	factor := math.Pow10(decimals)
	return math.Round(value*factor) / factor
}
