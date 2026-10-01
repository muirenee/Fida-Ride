package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	adminStreamProtocol      = "fida-admin.v1"
	adminJWTProtocolPrefix   = "fida.jwt."
	adminJWTCookieName       = "fida_admin_access"
	adminDashboardPermission = "admin:dashboard:read"
	adminWildcardPermission  = "admin:*"
)

var errAdminForbidden = errors.New("admin permission denied")

type jwtHeader struct {
	Algorithm string `json:"alg"`
}

type adminJWTClaims struct {
	Subject     string          `json:"sub"`
	Role        string          `json:"role"`
	Issuer      string          `json:"iss"`
	Audience    json.RawMessage `json:"aud"`
	Permissions []string        `json:"permissions"`
	SessionID   string          `json:"sid"`
	JWTID       string          `json:"jti"`
	Expiry      int64           `json:"exp"`
	NotBefore   int64           `json:"nbf"`
}

type adminStreamPrincipal struct {
	Subject     string
	Role        string
	Permissions []string
	SessionID   string
	JWTID       string
	ExpiresAt   time.Time
}

type adminSessionRecord struct {
	Subject     string   `json:"sub"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
	JWTID       string   `json:"jti"`
}

func (s *Server) authenticateAdminStream(r *http.Request) (adminStreamPrincipal, error) {
	token := ""
	if cookie, err := r.Cookie(adminJWTCookieName); err == nil {
		token = strings.TrimSpace(cookie.Value)
	}

	if token == "" && s.cfg.AllowSubprotocolToken {
		encoded := ""
		for _, rawProtocol := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
			protocol := strings.TrimSpace(rawProtocol)
			if strings.HasPrefix(protocol, adminJWTProtocolPrefix) {
				encoded = strings.TrimPrefix(protocol, adminJWTProtocolPrefix)
				break
			}
		}
		if encoded != "" {
			tokenBytes, err := base64.RawURLEncoding.DecodeString(encoded)
			if err != nil {
				return adminStreamPrincipal{}, errors.New("admin JWT subprotocol encoding is invalid")
			}
			token = string(tokenBytes)
		}
	}

	if token == "" {
		return adminStreamPrincipal{}, errors.New("admin session cookie required")
	}

	principal, err := validateAdminJWT(
		token,
		s.cfg.AdminJWTSecret,
		s.cfg.AdminJWTIssuer,
		s.cfg.AdminJWTAudience,
		time.Now().UTC(),
	)
	if err != nil {
		return adminStreamPrincipal{}, err
	}

	ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
	defer cancel()

	raw, err := s.redis.Get(ctx, "admin:session:"+principal.SessionID).Result()
	if errors.Is(err, redis.Nil) {
		return adminStreamPrincipal{}, errors.New("admin session is no longer active")
	}
	if err != nil {
		return adminStreamPrincipal{}, errors.New("admin session validation unavailable")
	}

	var record adminSessionRecord
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		return adminStreamPrincipal{}, errors.New("admin session record is invalid")
	}
	if !sessionMatches(principal, record) {
		return adminStreamPrincipal{}, errors.New("admin session record mismatch")
	}

	return principal, nil
}

func validateAdminJWT(token, secret, issuer, audience string, now time.Time) (adminStreamPrincipal, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return adminStreamPrincipal{}, errors.New("malformed admin JWT")
	}

	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return adminStreamPrincipal{}, errors.New("invalid admin JWT header encoding")
	}
	var header jwtHeader
	if err := json.Unmarshal(headerBytes, &header); err != nil || header.Algorithm != "HS256" {
		return adminStreamPrincipal{}, errors.New("admin JWT must use HS256")
	}

	providedSignature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return adminStreamPrincipal{}, errors.New("invalid admin JWT signature encoding")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(providedSignature, mac.Sum(nil)) {
		return adminStreamPrincipal{}, errors.New("admin JWT signature mismatch")
	}

	claimsBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return adminStreamPrincipal{}, errors.New("invalid admin JWT claims encoding")
	}
	var claims adminJWTClaims
	if err := json.Unmarshal(claimsBytes, &claims); err != nil {
		return adminStreamPrincipal{}, errors.New("invalid admin JWT claims")
	}

	if claims.Issuer != issuer {
		return adminStreamPrincipal{}, errors.New("admin JWT issuer mismatch")
	}
	if !rawAudienceContains(claims.Audience, audience) {
		return adminStreamPrincipal{}, errors.New("admin JWT audience mismatch")
	}
	if claims.Expiry == 0 || now.Unix() >= claims.Expiry {
		return adminStreamPrincipal{}, errors.New("admin JWT expired or missing exp")
	}
	if claims.NotBefore != 0 && now.Unix() < claims.NotBefore {
		return adminStreamPrincipal{}, errors.New("admin JWT is not active yet")
	}
	if !validAdminRole(claims.Role) {
		return adminStreamPrincipal{}, errAdminForbidden
	}
	if !hasAdminPermission(claims.Permissions, adminDashboardPermission) {
		return adminStreamPrincipal{}, errAdminForbidden
	}

	subject := strings.TrimSpace(claims.Subject)
	sessionID := strings.TrimSpace(claims.SessionID)
	jwtID := strings.TrimSpace(claims.JWTID)
	if subject == "" || len(subject) > 128 || sessionID == "" || len(sessionID) > 128 || jwtID == "" || len(jwtID) > 128 {
		return adminStreamPrincipal{}, errors.New("admin JWT identity claims are invalid")
	}
	if len(claims.Permissions) > 128 {
		return adminStreamPrincipal{}, errors.New("admin JWT permissions are invalid")
	}
	for _, permission := range claims.Permissions {
		if permission == "" || len(permission) > 128 {
			return adminStreamPrincipal{}, errors.New("admin JWT permissions are invalid")
		}
	}

	return adminStreamPrincipal{
		Subject:     subject,
		Role:        claims.Role,
		Permissions: claims.Permissions,
		SessionID:   sessionID,
		JWTID:       jwtID,
		ExpiresAt:   time.Unix(claims.Expiry, 0).UTC(),
	}, nil
}

func validAdminRole(role string) bool {
	switch role {
	case "super_admin", "operations_admin", "finance_admin", "security_admin", "support_admin":
		return true
	default:
		return false
	}
}

func sessionMatches(principal adminStreamPrincipal, record adminSessionRecord) bool {
	if record.Subject != principal.Subject || record.Role != principal.Role || record.JWTID != principal.JWTID {
		return false
	}
	if len(record.Permissions) != len(principal.Permissions) {
		return false
	}
	left := append([]string(nil), record.Permissions...)
	right := append([]string(nil), principal.Permissions...)
	sort.Strings(left)
	sort.Strings(right)
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
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
