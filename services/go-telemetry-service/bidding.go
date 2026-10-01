package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const biddingEventsChan = "bidding:events"

var (
	riderConnMu sync.RWMutex
	riderConns  = make(map[string]map[*websocket.Conn]struct{})
)

type BiddingEvent struct {
	Event        string  `json:"event"`
	TripID       string  `json:"trip_id"`
	RiderID      string  `json:"rider_id"`
	DriverID     string  `json:"driver_id"`
	ProposedFare float64 `json:"proposed_fare"`
	DriverRating float64 `json:"driver_rating"`
}

type RiderCounterOfferEvent struct {
	Event        string  `json:"event"`
	TripID       string  `json:"trip_id"`
	DriverID     string  `json:"driver_id"`
	ProposedFare float64 `json:"proposed_fare"`
	DriverRating float64 `json:"driver_rating"`
}

func (s *Server) riderWebSocketHandler(w http.ResponseWriter, r *http.Request) {
	riderID, err := s.authenticateRider(r)
	if err != nil {
		s.logger.Warn("rider websocket authentication rejected", "remote_ip", clientIP(r), "error", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Warn("rider websocket upgrade failed", "rider_id", riderID, "remote_ip", clientIP(r), "error", err)
		return
	}
	defer conn.Close()

	s.registerRiderConnection(conn, riderID)
	defer s.unregisterRiderConnection(conn, riderID)

	conn.SetReadLimit(1024)
	_ = conn.SetReadDeadline(time.Now().Add(s.cfg.IdleConnectionTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(s.cfg.IdleConnectionTimeout))
	})

	done := make(chan struct{})
	go s.riderPingLoop(conn, riderID, done)
	defer close(done)

	s.logger.Info("rider websocket connected", "rider_id", riderID, "remote_ip", clientIP(r))

	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseGoingAway,
				websocket.CloseNormalClosure,
				websocket.CloseNoStatusReceived,
			) {
				s.logger.Warn("rider websocket closed unexpectedly", "rider_id", riderID, "error", err)
			} else {
				s.logger.Info("rider websocket disconnected", "rider_id", riderID)
			}
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(s.cfg.IdleConnectionTimeout))
	}
}

func (s *Server) authenticateRider(r *http.Request) (string, error) {
	token := bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	if token == "" {
		return "", errors.New("missing bearer token")
	}
	if s.cfg.JWTSecret == "" {
		return "", errors.New("JWT authentication is not configured")
	}

	subject, err := validateHS256JWT(token, s.cfg.JWTSecret, time.Now().UTC())
	if err != nil {
		return "", fmt.Errorf("invalid JWT: %w", err)
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errors.New("malformed token")
	}
	claimsBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", errors.New("invalid JWT claims encoding")
	}
	var claims jwtClaims
	if err := json.Unmarshal(claimsBytes, &claims); err != nil {
		return "", errors.New("invalid JWT claims")
	}
	if claims.Role != "rider" {
		return "", errors.New("rider role required")
	}

	riderID := strings.TrimSpace(claims.UserID)
	if riderID == "" {
		riderID = strings.TrimSpace(subject)
	}
	if err := validateDriverID(riderID); err != nil {
		return "", fmt.Errorf("invalid rider identity: %w", err)
	}
	return riderID, nil
}

func (s *Server) runBiddingEventSubscriber(ctx context.Context) {
	pubsub := s.redis.Subscribe(ctx, biddingEventsChan)
	defer func() {
		if err := pubsub.Close(); err != nil {
			s.logger.Warn("bidding pubsub close failed", "error", err)
		}
	}()

	if _, err := pubsub.Receive(ctx); err != nil {
		if !errors.Is(err, context.Canceled) {
			s.logger.Error("bidding pubsub subscription failed", "error", err)
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
			var event BiddingEvent
			if err := json.Unmarshal([]byte(message.Payload), &event); err != nil {
				s.logger.Warn("invalid bidding event ignored", "error", err)
				continue
			}
			if event.Event != "counter_offer_received" {
				continue
			}
			if event.RiderID == "" || event.TripID == "" || event.DriverID == "" || event.ProposedFare <= 0 {
				s.logger.Warn("incomplete counter-offer event ignored", "trip_id", event.TripID)
				continue
			}
			if event.DriverRating < 0 || event.DriverRating > 5 {
				s.logger.Warn("counter-offer rating out of range", "trip_id", event.TripID, "driver_id", event.DriverID)
				continue
			}

			payload := RiderCounterOfferEvent{
				Event:        "counter_offer_received",
				TripID:       event.TripID,
				DriverID:     event.DriverID,
				ProposedFare: event.ProposedFare,
				DriverRating: event.DriverRating,
			}
			s.broadcastToRider(event.RiderID, payload)
		}
	}
}

func (s *Server) broadcastToRider(riderID string, payload RiderCounterOfferEvent) {
	riderConnMu.RLock()
	connectionsMap := riderConns[riderID]
	connections := make([]*websocket.Conn, 0, len(connectionsMap))
	for conn := range connectionsMap {
		connections = append(connections, conn)
	}
	riderConnMu.RUnlock()

	for _, conn := range connections {
		_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if err := conn.WriteJSON(payload); err != nil {
			s.logger.Warn("rider bidding broadcast failed", "rider_id", riderID, "error", err)
			s.unregisterRiderConnection(conn, riderID)
			_ = conn.Close()
		}
	}
}

func (s *Server) registerRiderConnection(conn *websocket.Conn, riderID string) {
	riderConnMu.Lock()
	defer riderConnMu.Unlock()
	if riderConns[riderID] == nil {
		riderConns[riderID] = make(map[*websocket.Conn]struct{})
	}
	riderConns[riderID][conn] = struct{}{}
}

func (s *Server) unregisterRiderConnection(conn *websocket.Conn, riderID string) {
	riderConnMu.Lock()
	defer riderConnMu.Unlock()
	connections := riderConns[riderID]
	if connections == nil {
		return
	}
	delete(connections, conn)
	if len(connections) == 0 {
		delete(riderConns, riderID)
	}
}

func (s *Server) riderPingLoop(conn *websocket.Conn, riderID string, done <-chan struct{}) {
	ticker := time.NewTicker(s.cfg.PingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			deadline := time.Now().Add(3 * time.Second)
			if err := conn.WriteControl(websocket.PingMessage, nil, deadline); err != nil {
				s.logger.Debug("rider websocket ping failed", "rider_id", riderID, "error", err)
				return
			}
		}
	}
}

func (s *Server) closeAllRiderConnections(reason string) {
	riderConnMu.RLock()
	connections := make([]*websocket.Conn, 0)
	for _, riderConnections := range riderConns {
		for conn := range riderConnections {
			connections = append(connections, conn)
		}
	}
	riderConnMu.RUnlock()

	for _, conn := range connections {
		_ = writeClose(conn, websocket.CloseGoingAway, reason)
		_ = conn.Close()
	}
}
