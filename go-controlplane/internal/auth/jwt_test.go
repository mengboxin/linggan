package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func signedAccessToken(t *testing.T, secret string, expires int64) string {
	t.Helper()
	encode := func(value any) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(data)
	}
	header := encode(map[string]any{"alg": "HS256", "typ": "JWT"})
	payload := encode(map[string]any{"sub": "user-1", "email": "u@example.com", "role": "user", "type": "access", "exp": expires})
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(header + "." + payload))
	return header + "." + payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestValidateAccessTokenMatchesPythonHS256Claims(t *testing.T) {
	now := time.Unix(1_710_000_000, 0)
	token := signedAccessToken(t, "secret", now.Add(time.Hour).Unix())
	identity, err := ValidateAccessToken(token, "secret", now)
	if err != nil {
		t.Fatal(err)
	}
	if identity.UserID != "user-1" || identity.Email != "u@example.com" || identity.Role != "user" {
		t.Fatalf("unexpected identity: %#v", identity)
	}
}

func TestValidateAccessTokenRejectsExpiredOrForgedToken(t *testing.T) {
	now := time.Unix(1_710_000_000, 0)
	if _, err := ValidateAccessToken(signedAccessToken(t, "secret", now.Add(-time.Second).Unix()), "secret", now); err == nil {
		t.Fatal("expected expired token rejection")
	}
	if _, err := ValidateAccessToken(signedAccessToken(t, "other-secret", now.Add(time.Hour).Unix()), "secret", now); err == nil {
		t.Fatal("expected signature rejection")
	}
}
