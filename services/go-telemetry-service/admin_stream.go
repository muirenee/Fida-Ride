package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	activeTripKeyPrefix      = "driver:active-trip:"
	maxAdminControlFrameSize = 2 * 1024
)

type AdminDriverUpdate struct {
	ID     string  `json:"id"`
	Lat    float64 `json:"lat"`
	Lng    float64 `json:"lng"`
	Status string  `json:"status"`
	TripID *string `json:"trip_id"`
}

type adminViewport struct {
	West  float64 `json:"west"`
	South float64 `json:"south"`
	East  float64 `json:"east"`
	North float64 `json:"north"`
}

type adminControlMessage struct {
	Type string `json:"type"`
	adminViewport
}

type adminStreamClient struct {
	conn *websocket.Conn
	send chan []byte

	mu          sync.RWMutex
	viewport    adminViewport
	hasViewport bool
}

type AdminStreamHub struct {
	mu      sync.RWMutex
	clients map[*adminStreamClient]struct{}

	pendingMu sync.Mutex
	pending   map[string]AdminDriverUpdate
}

func NewAdminStreamHub() *AdminStreamHub {
	return &AdminStreamHub{
		clients: make(map[*adminStreamClient]struct{}),
		pending: make(map[string]AdminDriverUpdate),
	}
}

func (h *AdminStreamHub) register(client *adminStreamClient) {
	h.mu.Lock()
	h.clients[client] = struct{}{}
	h.mu.Unlock()
}

func (h *AdminStreamHub) unregister(client *adminStreamClient) {
	h.mu.Lock()
	delete(h.clients, client)
	h.mu.Unlock()
}

func (h *AdminStreamHub) stage(update AdminDriverUpdate) {
	h.pendingMu.Lock()
	h.pending[update.ID] = update
	h.pendingMu.Unlock()
}

func (h *AdminStreamHub) drain(max int) []AdminDriverUpdate {
	h.pendingMu.Lock()
	defer h.pendingMu.Unlock()

	if len(h.pending) == 0 {
		return nil
	}
	if max <= 0 || max > len(h.pending) {
		max = len(h.pending)
	}

	updates := make([]AdminDriverUpdate, 0, max)
	for id, update := range h.pending {
		updates = append(updates, update)
		delete(h.pending, id)
		if len(updates) == max {
			break
		}
	}
	return updates
}

func (h *AdminStreamHub) snapshotClients() []*adminStreamClient {
	h.mu.RLock()
	clients := make([]*adminStreamClient, 0, len(h.clients))
	for client := range h.clients {
		clients = append(clients, client)
	}
	h.mu.RUnlock()
	return clients
}

func (h *AdminStreamHub) closeAll(reason string) {
	for _, client := range h.snapshotClients() {
		_ = writeClose(client.conn, websocket.CloseGoingAway, reason)
		_ = client.conn.Close()
	}
}

func (client *adminStreamClient) setViewport(viewport adminViewport) {
	client.mu.Lock()
	client.viewport = viewport
	client.hasViewport = true
	client.mu.Unlock()
}

func (client *adminStreamClient) contains(update AdminDriverUpdate) bool {
	client.mu.RLock()
	viewport := client.viewport
	hasViewport := client.hasViewport
	client.mu.RUnlock()

	if !hasViewport {
		return false
	}
	return update.Lng >= viewport.West &&
		update.Lng <= viewport.East &&
		update.Lat >= viewport.South &&
		update.Lat <= viewport.North
}

func (client *adminStreamClient) enqueue(payload []byte) {
	select {
	case client.send <- payload:
		return
	default:
	}

	select {
	case <-client.send:
	default:
	}
	select {
	case client.send <- payload:
	default:
	}
}

func (s *Server) adminStreamHandler(w http.ResponseWriter, r *http.Request) {
	adminID, err := s.authenticateAdminStream(r)
	if err != nil {
		s.logger.Warn("admin stream authentication rejected", "remote_ip", clientIP(r), "error", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	upgrader := s.upgrader
	upgrader.Subprotocols = []string{adminStreamProtocol}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Warn("admin websocket upgrade failed", "admin_id", adminID, "error", err)
		return
	}
	defer conn.Close()

	client := &adminStreamClient{conn: conn, send: make(chan []byte, 2)}
	s.adminHub.register(client)
	defer s.adminHub.unregister(client)

	conn.SetReadLimit(maxAdminControlFrameSize)
	_ = conn.SetReadDeadline(time.Now().Add(s.cfg.IdleConnectionTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(s.cfg.IdleConnectionTimeout))
	})

	writerDone := make(chan struct{})
	go s.adminWriterLoop(client, writerDone)
	defer close(writerDone)

	s.logger.Info("admin telemetry stream connected", "admin_id", adminID, "remote_ip", clientIP(r))

	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(s.cfg.IdleConnectionTimeout))
		if messageType != websocket.TextMessage {
			continue
		}

		var message adminControlMessage
		decoder := json.NewDecoder(strings.NewReader(string(payload)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&message); err != nil {
			continue
		}
		if message.Type == "viewport" && validAdminViewport(message.adminViewport) {
			client.setViewport(message.adminViewport)
		}
	}
}

func (s *Server) adminWriterLoop(client *adminStreamClient, done <-chan struct{}) {
	ticker := time.NewTicker(s.cfg.PingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case payload := <-client.send:
			_ = client.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if err := client.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				_ = client.conn.Close()
				return
			}
		case <-ticker.C:
			if err := client.conn.WriteControl(
				websocket.PingMessage,
				[]byte("ping"),
				time.Now().Add(2*time.Second),
			); err != nil {
				_ = client.conn.Close()
				return
			}
		}
	}
}

func validAdminViewport(viewport adminViewport) bool {
	return viewport.West >= -180 && viewport.West <= 180 &&
		viewport.East >= -180 && viewport.East <= 180 &&
		viewport.South >= -90 && viewport.South <= 90 &&
		viewport.North >= -90 && viewport.North <= 90 &&
		viewport.West < viewport.East &&
		viewport.South < viewport.North
}

func (s *Server) runAdminTelemetrySubscriber(ctx context.Context) {
	pubsub := s.redis.Subscribe(ctx, updatesChan)
	defer func() { _ = pubsub.Close() }()

	if _, err := pubsub.Receive(ctx); err != nil {
		if !errors.Is(err, context.Canceled) {
			s.logger.Error("admin telemetry subscription failed", "error", err)
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
			var packet TelemetryPacket
			if err := json.Unmarshal([]byte(message.Payload), &packet); err != nil {
				continue
			}
			status := "busy"
			if packet.Status == "available" || packet.Status == "online" {
				status = "online"
			}
			s.adminHub.stage(AdminDriverUpdate{
				ID: packet.DriverID, Lat: packet.Latitude, Lng: packet.Longitude, Status: status,
			})
		}
	}
}

func (s *Server) runAdminStreamFlusher(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.AdminStreamFlushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			updates := s.adminHub.drain(s.cfg.AdminStreamMaxBatch)
			if len(updates) == 0 {
				continue
			}
			s.enrichAdminTripIDs(ctx, updates)
			s.broadcastAdminUpdates(updates)
		}
	}
}

func (s *Server) enrichAdminTripIDs(parent context.Context, updates []AdminDriverUpdate) {
	keys := make([]string, 0, len(updates))
	indexes := make([]int, 0, len(updates))
	for index, update := range updates {
		if update.Status != "busy" {
			continue
		}
		keys = append(keys, activeTripKeyPrefix+update.ID)
		indexes = append(indexes, index)
	}
	if len(keys) == 0 {
		return
	}

	ctx, cancel := context.WithTimeout(parent, 100*time.Millisecond)
	defer cancel()
	values, err := s.redis.MGet(ctx, keys...).Result()
	if err != nil {
		return
	}
	for position, value := range values {
		if value == nil || position >= len(indexes) {
			continue
		}
		tripID := strings.TrimSpace(fmt.Sprint(value))
		if tripID != "" {
			updates[indexes[position]].TripID = &tripID
		}
	}
}

func (s *Server) broadcastAdminUpdates(updates []AdminDriverUpdate) {
	for _, client := range s.adminHub.snapshotClients() {
		filtered := make([]AdminDriverUpdate, 0, len(updates))
		for _, update := range updates {
			if client.contains(update) {
				filtered = append(filtered, update)
			}
		}
		if len(filtered) == 0 {
			continue
		}
		payload, err := json.Marshal(filtered)
		if err == nil {
			client.enqueue(payload)
		}
	}
}
