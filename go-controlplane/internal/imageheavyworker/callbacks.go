// Package imageheavyworker owns the isolated Flux Fill edit path.
package imageheavyworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
)

const maxCallbackBody = 64 << 10

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type HTTPError struct {
	StatusCode int
	Message    string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("internal image heavy callback returned HTTP %d: %s", e.StatusCode, e.Message)
}
func (e *HTTPError) Retryable() bool {
	return e.StatusCode == 408 || e.StatusCode == 409 || e.StatusCode == 425 || e.StatusCode == 429 || e.StatusCode >= 500
}

type HTTPCallbacks struct {
	baseURL, secret string
	http            HTTPDoer
}

func NewHTTPCallbacks(baseURL, secret string, client HTTPDoer) (*HTTPCallbacks, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || strings.TrimSpace(secret) == "" {
		return nil, errors.New("image heavy callback URL and shared secret are required")
	}
	if client == nil {
		client = http.DefaultClient
	}
	return &HTTPCallbacks{baseURL: baseURL, secret: secret, http: client}, nil
}

func (c *HTTPCallbacks) FetchInput(ctx context.Context, in InputRequest) ([]byte, error) {
	values := url.Values{}
	values.Set("key", in.Key)
	values.Set("task_id", in.TaskID)
	req, err := c.newRequest(ctx, http.MethodGet, "/api/internal/go-image-heavy/input?"+values.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Task-User-ID", in.UserID)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, callbackError(resp)
	}
	limit := in.MaxBytes + 1
	if limit <= 1 {
		limit = defaultMaxInputBytes + 1
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) >= limit {
		return nil, errors.New("image heavy input exceeds configured limits")
	}
	return data, nil
}

func (c *HTTPCallbacks) Lease(ctx context.Context, in LeaseRequest) (Lease, error) {
	body, err := json.Marshal(map[string]any{"task_id": in.TaskID, "user_id": in.UserID, "model_id": in.ModelID, "prompt": in.Prompt, "mode": in.Mode, "target_color": in.TargetColor, "billing_mode": in.BillingMode})
	if err != nil {
		return Lease{}, err
	}
	req, err := c.newRequest(ctx, http.MethodPost, "/api/internal/go-image-heavy/lease", bytes.NewReader(body))
	if err != nil {
		return Lease{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return Lease{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		return Lease{}, ErrLeaseAlreadyClaimed
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Lease{}, callbackError(resp)
	}
	var out struct {
		Endpoint    string  `json:"endpoint"`
		APIKey      string  `json:"api_key"`
		Prompt      string  `json:"prompt"`
		Strength    float64 `json:"strength"`
		BillingMode string  `json:"billing_mode"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxCallbackBody)).Decode(&out); err != nil {
		return Lease{}, err
	}
	return Lease{Endpoint: out.Endpoint, APIKey: out.APIKey, Prompt: out.Prompt, Strength: out.Strength, BillingMode: out.BillingMode}, nil
}

func (c *HTTPCallbacks) Complete(ctx context.Context, in CompletionRequest) error {
	reader, writer := io.Pipe()
	form := multipart.NewWriter(writer)
	done := make(chan error, 1)
	go func() {
		err := writeCompletion(form, in)
		if closeErr := form.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = writer.CloseWithError(err)
		} else {
			_ = writer.Close()
		}
		done <- err
	}()
	req, err := c.newRequest(ctx, http.MethodPost, "/api/internal/go-image-heavy/complete", reader)
	if err != nil {
		_ = reader.Close()
		<-done
		return err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	resp, err := c.http.Do(req)
	if err != nil {
		_ = reader.CloseWithError(err)
		<-done
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = reader.Close()
		<-done
		return callbackError(resp)
	}
	return <-done
}

func (c *HTTPCallbacks) Fail(ctx context.Context, in FailureRequest) error {
	return c.postJSON(ctx, "/api/internal/go-image-heavy/failed", map[string]any{"task_id": in.TaskID, "user_id": in.UserID, "error": in.Error, "billing_mode": in.BillingMode})
}

func (c *HTTPCallbacks) postJSON(ctx context.Context, path string, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	req, err := c.newRequest(ctx, http.MethodPost, path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return callbackError(resp)
	}
	return nil
}

func (c *HTTPCallbacks) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Control-Plane-Secret", c.secret)
	return req, nil
}

func callbackError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxCallbackBody))
	msg := strings.TrimSpace(string(body))
	if len(msg) > 512 {
		msg = msg[:512]
	}
	return &HTTPError{StatusCode: resp.StatusCode, Message: msg}
}

func writeCompletion(form *multipart.Writer, in CompletionRequest) error {
	fields := map[string]string{"task_id": in.TaskID, "user_id": in.UserID, "model_id": in.ModelID, "prompt": in.Prompt, "mode": in.Mode, "element_id": in.ElementID, "completion_id": in.CompletionID, "billing_mode": in.BillingMode}
	for _, key := range []string{"task_id", "user_id", "model_id", "prompt", "mode", "element_id", "completion_id", "billing_mode"} {
		if err := form.WriteField(key, fields[key]); err != nil {
			return err
		}
	}
	part, err := form.CreateFormFile("image", "image.png")
	if err != nil {
		return err
	}
	_, err = part.Write(in.Image)
	return err
}
