package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

type Config struct {
	Addr                     string
	RedisAddr                string
	RedisPassword            string
	RedisDB                  int
	AdminJWTSecret           string
	AdminJWTIssuer           string
	AdminJWTAudience         string
	AllowSubprotocolToken    bool
	AllowedOrigins           map[string]struct{}
	IdleTimeout              time.Duration
	PingInterval             time.Duration
	AdminStreamFlushInterval time.Duration
	AdminStreamMaxBatch      int
}

type Server struct {
	cfg      Config
	redis    *redis.Client
	logger   *slog.Logger
	upgrader websocket.Upgrader
	hub      *AdminStreamHub
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := loadConfig()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	rdb := redis.NewClient(&redis.Options{
		Addr:         cfg.RedisAddr,
		Password:     cfg.RedisPassword,
		DB:           cfg.RedisDB,
		DialTimeout:  3 * time.Second,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
		PoolSize:     64,
		MinIdleConns: 4,
	})

	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelStartup()
	if err := rdb.Ping(startupCtx).Err(); err != nil {
		logger.Error("redis unavailable", "error", err)
		os.Exit(1)
	}

	server := &Server{
		cfg:    cfg,
		redis:  rdb,
		logger: logger,
		hub:    NewAdminStreamHub(),
	}
	server.upgrader = websocket.Upgrader{
		HandshakeTimeout: 5 * time.Second,
		ReadBufferSize:   1024,
		WriteBufferSize:  4096,
		CheckOrigin:      server.checkOrigin,
		Subprotocols:     []string{adminStreamProtocol},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", server.healthHandler)
	mux.HandleFunc("/readyz", server.healthHandler)
	mux.HandleFunc("/admin/stream", server.adminStreamHandler)

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           recoveryMiddleware(logger, mux),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go server.runTelemetrySubscriber(ctx)
	go server.runFlusher(ctx)

	serverErr := make(chan error, 1)
	go func() {
		logger.Info(
			"admin stream service started",
			"addr", cfg.Addr,
			"flush_interval", cfg.AdminStreamFlushInterval.String(),
			"max_batch", cfg.AdminStreamMaxBatch,
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
	server.hub.closeAll("server shutting down")
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("http server shutdown failed", "error", err)
	}
	if err := rdb.Close(); err != nil {
		logger.Error("redis close failed", "error", err)
	}
}

func loadConfig() (Config, error) {
	redisDB, err := envInt("REDIS_DB", 0)
	if err != nil {
		return Config{}, err
	}
	maxBatch, err := envInt("ADMIN_STREAM_MAX_BATCH", 5000)
	if err != nil {
		return Config{}, err
	}
	allowSubprotocolToken, err := envBool("ADMIN_WS_ALLOW_SUBPROTOCOL_TOKEN", false)
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
	flushInterval, err := envDuration("ADMIN_STREAM_FLUSH_INTERVAL", 250*time.Millisecond)
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		Addr:                     env("HTTP_ADDR", ":8090"),
		RedisAddr:                env("REDIS_ADDR", "redis:6379"),
		RedisPassword:            os.Getenv("REDIS_PASSWORD"),
		RedisDB:                  redisDB,
		AdminJWTSecret:           strings.TrimSpace(os.Getenv("ADMIN_JWT_HS256_SECRET")),
		AdminJWTIssuer:           env("ADMIN_JWT_ISSUER", "fida-ride-admin"),
		AdminJWTAudience:         env("ADMIN_JWT_AUDIENCE", "fida-admin"),
		AllowSubprotocolToken:    allowSubprotocolToken,
		AllowedOrigins:           parseOrigins(os.Getenv("ADMIN_WS_ALLOWED_ORIGINS")),
		IdleTimeout:              idleTimeout,
		PingInterval:             pingInterval,
		AdminStreamFlushInterval: flushInterval,
		AdminStreamMaxBatch:      maxBatch,
	}

	if len(cfg.AdminJWTSecret) < 32 {
		return Config{}, errors.New("ADMIN_JWT_HS256_SECRET must contain at least 32 characters")
	}
	if cfg.AdminStreamFlushInterval < 50*time.Millisecond {
		return Config{}, errors.New("ADMIN_STREAM_FLUSH_INTERVAL must be at least 50ms")
	}
	if cfg.AdminStreamMaxBatch < 1 || cfg.AdminStreamMaxBatch > 50000 {
		return Config{}, errors.New("ADMIN_STREAM_MAX_BATCH must be between 1 and 50000")
	}
	if cfg.PingInterval <= 0 || cfg.PingInterval >= cfg.IdleTimeout {
		return Config{}, errors.New("WS_PING_INTERVAL must be positive and lower than WS_IDLE_TIMEOUT")
	}
	return cfg, nil
}

func (s *Server) healthHandler(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	if err := s.redis.Ping(ctx).Err(); err != nil {
		http.Error(w, "redis unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("{\"status\":\"ok\",\"service\":\"go-admin-stream-service\"}"))
}

func (s *Server) checkOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	_, ok := s.cfg.AllowedOrigins[strings.ToLower(parsed.Scheme+"://"+parsed.Host)]
	return ok
}

func recoveryMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.Error("request panic recovered", "error", fmt.Sprint(recovered))
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func parseOrigins(raw string) map[string]struct{} {
	result := make(map[string]struct{})
	for _, value := range strings.Split(raw, ",") {
		value = strings.TrimSpace(strings.ToLower(value))
		if value != "" {
			result[value] = struct{}{}
		}
	}
	return result
}

func env(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envInt(key string, fallback int) (int, error) {
	value := env(key, strconv.Itoa(fallback))
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return parsed, nil
}

func envBool(key string, fallback bool) (bool, error) {
	value := env(key, strconv.FormatBool(fallback))
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s: %w", key, err)
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
