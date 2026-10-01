package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

const securityDisconnectChannel = "security:disconnect"

var removeDriverSecurityStateScript = redis.NewScript(`
local driverID = ARGV[1]
local activeKey = ARGV[2] .. driverID
local sessionID = redis.call('GET', activeKey)
redis.call('DEL', activeKey)
if sessionID then
  redis.call('DEL', ARGV[3] .. driverID .. ':' .. sessionID)
  redis.call('DEL', ARGV[4] .. driverID .. ':' .. sessionID)
end
redis.call('ZREM', KEYS[1], driverID)
redis.call('ZREM', KEYS[2], driverID)
redis.call('DEL', ARGV[5] .. driverID)
redis.call('DEL', ARGV[6] .. driverID)
return sessionID or ''
`)

type SecurityDisconnectEvent struct {
	Event    string `json:"event"`
	UserID   string `json:"user_id"`
	DriverID string `json:"driver_id"`
	Action   string `json:"action"`
	Reason   string `json:"reason"`
	IssuedAt string `json:"issued_at"`
}

func (s *Server) runSecurityDisconnectSubscriber(ctx context.Context) {
	pubsub := s.redis.Subscribe(ctx, securityDisconnectChannel)
	defer func() {
		if err := pubsub.Close(); err != nil {
			s.logger.Warn("security disconnect pubsub close failed", "error", err)
		}
	}()

	if _, err := pubsub.Receive(ctx); err != nil {
		if !errors.Is(err, context.Canceled) {
			s.logger.Error("security disconnect subscription failed", "error", err)
		}
		return
	}

	channel := pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case message, ok := <-channel:
			if !ok {
				return
			}

			var event SecurityDisconnectEvent
			if err := json.Unmarshal([]byte(message.Payload), &event); err != nil {
				s.logger.Warn("invalid security disconnect event ignored", "error", err)
				continue
			}
			if event.Event != "security_disconnect" {
				continue
			}

			reason := strings.TrimSpace(event.Reason)
			if reason == "" {
				reason = "security policy"
			}

			if event.DriverID != "" {
				s.closeDriverConnections(event.DriverID, reason)
				s.removeDriverRealtimeState(event.DriverID)
			}
			if event.UserID != "" {
				s.closeRiderConnections(event.UserID, reason)
			}
		}
	}
}

func (s *Server) closeDriverConnections(driverID, reason string) {
	s.connMu.Lock()
	connections := make([]*websocket.Conn, 0)
	for conn, connectedDriverID := range s.conns {
		if connectedDriverID == driverID {
			connections = append(connections, conn)
		}
	}
	s.connMu.Unlock()

	for _, conn := range connections {
		_ = writeClose(conn, websocket.ClosePolicyViolation, reason)
		_ = conn.Close()
	}
}

func (s *Server) closeRiderConnections(riderID, reason string) {
	riderConnMu.RLock()
	connectionsMap := riderConns[riderID]
	connections := make([]*websocket.Conn, 0, len(connectionsMap))
	for conn := range connectionsMap {
		connections = append(connections, conn)
	}
	riderConnMu.RUnlock()

	for _, conn := range connections {
		_ = writeClose(conn, websocket.ClosePolicyViolation, reason)
		_ = conn.Close()
	}
}

func (s *Server) removeDriverRealtimeState(driverID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()

	if _, err := removeDriverSecurityStateScript.Run(
		ctx,
		s.redis,
		[]string{locationsKey, lastSeenKey},
		driverID,
		telemetryActiveSessionPrefix,
		telemetrySessionPrefix,
		telemetrySequencePrefix,
		presencePref,
		telemetryFraudStatePrefix,
	).Result(); err != nil {
		s.logger.Error(
			"failed to remove suspended driver realtime and signing state",
			"driver_id", driverID,
			"error", err,
		)
	}
}
