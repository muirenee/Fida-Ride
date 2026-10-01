package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func TestValidateAdminJWT(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	now := time.Unix(1_800_000_000, 0).UTC()

	header, _ := json.Marshal(map[string]any{"alg": "HS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"sub":  "admin-001",
		"role": "admin",
		"iss":  "fida-ride-admin",
		"aud":  "fida-admin",
		"exp":  now.Add(time.Minute).Unix(),
	})

	headerPart := base64.RawURLEncoding.EncodeToString(header)
	claimsPart := base64.RawURLEncoding.EncodeToString(claims)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(headerPart + "." + claimsPart))
	token := headerPart + "." + claimsPart + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	subject, err := validateAdminJWT(
		token,
		secret,
		"fida-ride-admin",
		"fida-admin",
		now,
	)
	if err != nil {
		t.Fatalf("expected valid token, got %v", err)
	}
	if subject != "admin-001" {
		t.Fatalf("unexpected subject %q", subject)
	}
}

func TestValidAdminViewport(t *testing.T) {
	if !validAdminViewport(adminViewport{West: 30.0, South: -2.1, East: 30.2, North: -1.8}) {
		t.Fatal("expected Kigali viewport to be valid")
	}
	if validAdminViewport(adminViewport{West: 31, South: -2, East: 30, North: -1}) {
		t.Fatal("expected inverted longitude bounds to be rejected")
	}
}
