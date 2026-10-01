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
		"sub":         "admin-001",
		"role":        "super_admin",
		"iss":         "fida-ride-admin",
		"aud":         "fida-admin",
		"permissions": []string{"admin:dashboard:read"},
		"sid":         "session-001",
		"jti":         "jwt-001",
		"exp":         now.Add(time.Minute).Unix(),
	})

	headerPart := base64.RawURLEncoding.EncodeToString(header)
	claimsPart := base64.RawURLEncoding.EncodeToString(claims)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(headerPart + "." + claimsPart))
	token := headerPart + "." + claimsPart + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	principal, err := validateAdminJWT(
		token,
		secret,
		"fida-ride-admin",
		"fida-admin",
		now,
	)
	if err != nil {
		t.Fatalf("expected valid token, got %v", err)
	}
	if principal.Subject != "admin-001" || principal.SessionID != "session-001" || principal.JWTID != "jwt-001" {
		t.Fatalf("unexpected principal %#v", principal)
	}
}

func TestValidateAdminJWTRejectsMissingDashboardPermission(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	now := time.Unix(1_800_000_000, 0).UTC()

	header, _ := json.Marshal(map[string]any{"alg": "HS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"sub":         "admin-002",
		"role":        "operations_admin",
		"iss":         "fida-ride-admin",
		"aud":         "fida-admin",
		"permissions": []string{"admin:geofences:write"},
		"sid":         "session-002",
		"jti":         "jwt-002",
		"exp":         now.Add(time.Minute).Unix(),
	})

	headerPart := base64.RawURLEncoding.EncodeToString(header)
	claimsPart := base64.RawURLEncoding.EncodeToString(claims)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(headerPart + "." + claimsPart))
	token := headerPart + "." + claimsPart + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	if _, err := validateAdminJWT(
		token,
		secret,
		"fida-ride-admin",
		"fida-admin",
		now,
	); err == nil {
		t.Fatal("expected admin JWT without dashboard permission to be rejected")
	}
}

func TestSessionMatchesRequiresExactClaims(t *testing.T) {
	principal := adminStreamPrincipal{
		Subject:     "admin-003",
		Role:        "security_admin",
		Permissions: []string{"admin:dashboard:read", "admin:fraud:read"},
		SessionID:   "session-003",
		JWTID:       "jwt-003",
	}
	record := adminSessionRecord{
		Subject:     principal.Subject,
		Role:        principal.Role,
		Permissions: []string{"admin:fraud:read", "admin:dashboard:read"},
		JWTID:       principal.JWTID,
	}
	if !sessionMatches(principal, record) {
		t.Fatal("expected session claims to match independent of permission ordering")
	}
	record.JWTID = "different"
	if sessionMatches(principal, record) {
		t.Fatal("expected mismatched JWT ID to be rejected")
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
