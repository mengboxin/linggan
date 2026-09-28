// Package auth verifies the existing Python HS256 access-token contract.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Identity struct {
	UserID string
	Email  string
	Role   string
}

type header struct {
	Algorithm string `json:"alg"`
}

type claims struct {
	Subject string  `json:"sub"`
	Email   string  `json:"email"`
	Role    string  `json:"role"`
	Type    string  `json:"type"`
	Expires float64 `json:"exp"`
}

func ValidateAccessToken(token, secret string, now time.Time) (Identity, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || secret == "" {
		return Identity{}, errors.New("invalid access token")
	}
	providedSignature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Identity{}, errors.New("invalid access token")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(providedSignature, mac.Sum(nil)) {
		return Identity{}, errors.New("invalid access token")
	}

	decodedHeader, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Identity{}, errors.New("invalid access token")
	}
	var tokenHeader header
	if json.Unmarshal(decodedHeader, &tokenHeader) != nil || tokenHeader.Algorithm != "HS256" {
		return Identity{}, errors.New("invalid access token")
	}
	decodedClaims, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Identity{}, errors.New("invalid access token")
	}
	var tokenClaims claims
	if json.Unmarshal(decodedClaims, &tokenClaims) != nil || tokenClaims.Type != "access" || tokenClaims.Subject == "" || tokenClaims.Expires <= float64(now.Unix()) {
		return Identity{}, errors.New("invalid access token")
	}
	return Identity{UserID: tokenClaims.Subject, Email: tokenClaims.Email, Role: tokenClaims.Role}, nil
}
