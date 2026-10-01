package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const (
	adminStreamProtocol       = "fida-admin.v1"
	adminJWTProtocolPrefix    = "fida.jwt."
	adminJWTCookieName        = "fida_admin_access"
	adminDashboardPermission  = "admin:dashboard:read"
	adminWildcardPermission   = "admin:*"
)

type jwtHeader struct {
	Algorithm string `json:"alg"`
}

type adminJWTClaims struct {
	Subject     string          `json:"sub"`
	Role        string          `json:"role"`
	Issuer      string          `json:"iss"`
	Audience    json.RawMessage `json:"aud"`
	Permissions []string        `json:"permissions"`
	Expiry      int64           `json:"exp"`
	NotBefore   int64           `json:"nbf"`
}

func (s *Server) authenticateAdminStream(r *http.Request) (string, error) {
	token := ""
	if cookie, err := r.Cookie(adminJWTCookieName); err == nil {
		token = strings.TrimSpace(cookie.Value)
	}

	// Subprotocol auth is retained for CLI/testing clients that cannot use the
	// browser's HttpOnly cookie. The JWT is base64url-wrapped so it remains a valid
	// WebSocket protocol token and is never placed in the URL/query string.
	if token == "" {
		encoded := ""
		for _, rawProtocol := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
			protocol := strings.TrimSpace(rawProtocol)
			if strings.HasPrefix(protocol, adminJWTProtocolPrefix) {
				encoded = strings.TrimPrefix(protocol, adminJWTProtocolPrefix)
				break
			}
		}
		if encoded == "" {
			return "", errors.New("admin JWT cookie or websocket subprotocol is required")
		}

		tokenBytes, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil {
			return "", errors.New("admin JWT subprotocol encoding is invalid")
		}
		token = string(tokenBytes)
	}

	return validateAdminJWT(
		token,
		s.cfg.AdminJWTSecret,
		s.cfg.AdminJWTIssuer,
		s.cfg.AdminJWTAudience,
		time.Now().UTC(),
	)
}

func validateAdminJWT(token, secret, issuer, audience string, now time.Time) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errors.New("malformed admin JWT")
	}

	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", errors.New("invalid admin JWT header encoding")
	}
	var header jwtHeader
	if err := json.Unmarshal(headerBytes, &header); err != nil || header.Algorithm != "HS256" {
		return "", errors.New("admin JWT must use HS256")
	}

	providedSignature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", errors.New("invalid admin JWT signature encoding")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(providedSignature, mac.Sum(nil)) {
		return "", errors.New("admin JWT signature mismatch")
	}

	claimsBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", errors.New("invalid admin JWT claims encoding")
	}
	var claims adminJWTClaims
	if err := json.Unmarshal(claimsBytes, &claims); err != nil {
		return "", errors.New("invalid admin JWT claims")
	}

	if claims.Role != "admin" {
		return "", errors.New("admin role required")
	}
	if !hasAdminPermission(claims.Permissions, adminDashboardPermission) {
		return "", errors.New("admin dashboard permission required")
	}
	if claims.Issuer != issuer {
		return "", errors.New("admin JWT issuer mismatch")
	}
	if !rawAudienceContains(claims.Audience, audience) {
		return "", errors.New("admin JWT audience mismatch")
	}
	if claims.Expiry == 0 || now.Unix() >= claims.Expiry {
		return "", errors.New("admin JWT expired or missing exp")
	}
	if claims.NotBefore != 0 && now.Unix() < claims.NotBefore {
		return "", errors.New("admin JWT is not active yet")
	}

	subject := strings.TrimSpace(claims.Subject)
	if subject == "" || len(subject) > 128 {
		return "", errors.New("admin JWT subject is invalid")
	}
	return subject, nil
}

func hasAdminPermission(permissions []string, required string) bool {
	for _, permission := range permissions {
		if permission == required || permission == adminWildcardPermission {
			return true
		}
	}
	return false
}

func rawAudienceContains(raw json.RawMessage, expected string) bool {
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return single == expected
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return false
	}
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
