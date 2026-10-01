package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	telemetryActiveSessionPrefix = "telemetry:active-session:"
	telemetrySessionPrefix       = "telemetry:session:"
	telemetrySequencePrefix      = "telemetry:sequence:"
	driverFinancialBlockPrefix   = "finance:driver-online-block:"
)

var advanceTelemetrySequenceScript = redis.NewScript(`
local current = redis.call('GET', KEYS[1])
if current and tonumber(ARGV[1]) <= tonumber(current) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`)

type telemetrySignatureSettings struct {
	MaxClockSkew time.Duration
	RedisTimeout time.Duration
	SequenceTTL  time.Duration
}

func loadTelemetrySignatureSettings() (telemetrySignatureSettings, error) {
	maxClockSkew, err := envDuration("TELEMETRY_SIGNATURE_MAX_CLOCK_SKEW", 30*time.Second)
	if err != nil {
		return telemetrySignatureSettings{}, err
	}
	redisTimeout, err := envDuration("TELEMETRY_SIGNATURE_REDIS_TIMEOUT", 100*time.Millisecond)
	if err != nil {
		return telemetrySignatureSettings{}, err
	}
	sequenceTTL, err := envDuration("TELEMETRY_SEQUENCE_TTL", 20*time.Minute)
	if err != nil {
		return telemetrySignatureSettings{}, err
	}
	if maxClockSkew <= 0 || redisTimeout <= 0 || sequenceTTL <= 0 {
		return telemetrySignatureSettings{}, errors.New("telemetry signature durations must be positive")
	}
	return telemetrySignatureSettings{
		MaxClockSkew: maxClockSkew,
		RedisTimeout: redisTimeout,
		SequenceTTL:  sequenceTTL,
	}, nil
}

func (s *Server) verifyTelemetrySignature(packet TelemetryPacket) error {
	settings, err := loadTelemetrySignatureSettings()
	if err != nil {
		return err
	}

	observedAt := time.Now().UTC()
	packetTime := time.UnixMilli(packet.Timestamp).UTC()
	clockSkew := observedAt.Sub(packetTime)
	if clockSkew < 0 {
		clockSkew = -clockSkew
	}
	if clockSkew > settings.MaxClockSkew {
		return fmt.Errorf("telemetry timestamp outside allowed skew: %s", clockSkew)
	}

	ctx, cancel := context.WithTimeout(context.Background(), settings.RedisTimeout)
	defer cancel()

	activeKey := telemetryActiveSessionPrefix + packet.DriverID
	sessionKey := telemetrySessionPrefix + packet.DriverID + ":" + packet.SessionID
	financialBlockKey := driverFinancialBlockPrefix + packet.DriverID

	// Financial eligibility is checked in the same Redis pipeline as session
	// validation, so the debt guard does not add another network round trip.
	pipe := s.redis.Pipeline()
	activeCmd := pipe.Get(ctx, activeKey)
	secretCmd := pipe.Get(ctx, sessionKey)
	financialBlockCmd := pipe.Get(ctx, financialBlockKey)
	_, execErr := pipe.Exec(ctx)
	if execErr != nil && !errors.Is(execErr, redis.Nil) {
		return fmt.Errorf("load telemetry signing session: %w", execErr)
	}

	if blockValue, blockErr := financialBlockCmd.Result(); blockErr == nil {
		if strings.TrimSpace(blockValue) != "" {
			return errors.New("driver telemetry blocked by financial credit policy")
		}
	} else if !errors.Is(blockErr, redis.Nil) {
		return fmt.Errorf("load driver financial eligibility: %w", blockErr)
	}

	activeSession, err := activeCmd.Result()
	if err != nil {
		return errors.New("driver has no active telemetry signing session")
	}
	if !hmac.Equal([]byte(activeSession), []byte(packet.SessionID)) {
		return errors.New("telemetry session is not active")
	}

	encodedSecret, err := secretCmd.Result()
	if err != nil {
		return errors.New("telemetry session key is unavailable or expired")
	}
	secret, err := base64.StdEncoding.DecodeString(encodedSecret)
	if err != nil || len(secret) != sha256.Size {
		return errors.New("telemetry session key is invalid")
	}

	providedSignature, err := hex.DecodeString(packet.Signature)
	if err != nil || len(providedSignature) != sha256.Size {
		return errors.New("telemetry signature encoding is invalid")
	}

	canonical := canonicalTelemetryPayload(packet)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(canonical))
	if !hmac.Equal(providedSignature, mac.Sum(nil)) {
		return errors.New("telemetry signature mismatch")
	}

	sequenceKey := telemetrySequencePrefix + packet.DriverID + ":" + packet.SessionID
	advanced, err := advanceTelemetrySequenceScript.Run(
		ctx,
		s.redis,
		[]string{sequenceKey},
		packet.Sequence,
		int64(settings.SequenceTTL/time.Second),
	).Int()
	if err != nil {
		return fmt.Errorf("advance telemetry replay sequence: %w", err)
	}
	if advanced != 1 {
		return errors.New("telemetry frame replay or out-of-order sequence detected")
	}

	return nil
}

func canonicalTelemetryPayload(packet TelemetryPacket) string {
	var builder strings.Builder
	builder.Grow(256)
	builder.WriteString("v1\n")
	builder.WriteString(packet.SessionID)
	builder.WriteByte('\n')
	builder.WriteString(packet.DriverID)
	builder.WriteByte('\n')
	builder.WriteString(strconv.FormatFloat(packet.Latitude, 'f', 7, 64))
	builder.WriteByte('\n')
	builder.WriteString(strconv.FormatFloat(packet.Longitude, 'f', 7, 64))
	builder.WriteByte('\n')
	builder.WriteString(strconv.FormatFloat(packet.Bearing, 'f', 2, 64))
	builder.WriteByte('\n')
	builder.WriteString(packet.Status)
	builder.WriteByte('\n')
	builder.WriteString(strconv.FormatInt(packet.Timestamp, 10))
	builder.WriteByte('\n')
	builder.WriteString(strconv.FormatInt(packet.Sequence, 10))
	return builder.String()
}
