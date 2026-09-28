package image2worker

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

const maxCallbackErrorBodyBytes = 64 << 10

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// HTTPError is deliberately small and credential-free so a generic Streams
// worker can safely log it while deciding whether a pre-upstream callback is
// safe to retry.
type HTTPError struct {
	StatusCode int
	Message    string
}

func (err *HTTPError) Error() string {
	if err.Message == "" {
		return fmt.Sprintf("internal image2 callback returned HTTP %d", err.StatusCode)
	}
	return fmt.Sprintf("internal image2 callback returned HTTP %d: %s", err.StatusCode, err.Message)
}

func (err *HTTPError) Retryable() bool {
	return err.StatusCode == http.StatusRequestTimeout ||
		err.StatusCode == http.StatusConflict ||
		err.StatusCode == http.StatusTooEarly ||
		err.StatusCode == http.StatusTooManyRequests ||
		err.StatusCode >= 500
}

// HTTPCallbacks calls the Python-only lifecycle authority on the private
// network. The secret and lease API key are never persisted or logged.
type HTTPCallbacks struct {
	baseURL string
	secret  string
	http    HTTPDoer
}

func NewHTTPCallbacks(baseURL, secret string, client HTTPDoer) (*HTTPCallbacks, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" || strings.TrimSpace(secret) == "" {
		return nil, errors.New("image2 callback URL and shared secret are required")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("image2 callback URL must be absolute")
	}
	if client == nil {
		client = http.DefaultClient
	}
	return &HTTPCallbacks{baseURL: baseURL, secret: secret, http: client}, nil
}

func (client *HTTPCallbacks) FetchInput(ctx context.Context, input InputRequest) ([]byte, error) {
	values := url.Values{}
	values.Set("key", input.Key)
	values.Set("task_id", input.TaskID)
	request, err := client.newRequest(ctx, http.MethodGet, "/api/internal/go-image2/input?"+values.Encode(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("X-Task-User-ID", input.UserID)
	response, err := client.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, callbackHTTPError(response)
	}
	if input.MaxBytes > 0 && response.ContentLength > input.MaxBytes {
		return nil, errors.New("image2 input exceeds configured limits")
	}
	limit := input.MaxBytes + 1
	if input.MaxBytes <= 0 {
		limit = defaultMaxInputBytes + 1
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit-1 {
		return nil, errors.New("image2 input exceeds configured limits")
	}
	return data, nil
}

func (client *HTTPCallbacks) Prepare(ctx context.Context, input PrepareRequest) error {
	return client.postJSON(ctx, "/api/internal/go-image2/prepare", map[string]any{
		"task_id": input.TaskID, "user_id": input.UserID, "model_id": input.ModelID,
		"progress": input.Progress, "billing_mode": input.BillingMode,
	})
}

func (client *HTTPCallbacks) Lease(ctx context.Context, input LeaseRequest) (Lease, error) {
	body, err := json.Marshal(map[string]any{
		"task_id":         input.TaskID,
		"user_id":         input.UserID,
		"model_id":        input.ModelID,
		"prompt":          input.Prompt,
		"source":          input.Source,
		"size":            input.Size,
		"image_quality":   input.ImageQuality,
		"force_size":      input.ForceSize,
		"reference_count": input.ReferenceCount,
		"billing_mode":    input.BillingMode,
	})
	if err != nil {
		return Lease{}, err
	}
	request, err := client.newRequest(ctx, http.MethodPost, "/api/internal/go-image2/lease", bytes.NewReader(body))
	if err != nil {
		return Lease{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.http.Do(request)
	if err != nil {
		return Lease{}, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		return Lease{}, ErrLeaseAlreadyClaimed
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Lease{}, callbackHTTPError(response)
	}
	var result leaseResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, maxCallbackErrorBodyBytes)).Decode(&result); err != nil {
		return Lease{}, fmt.Errorf("decode image2 runtime lease: %w", err)
	}
	return Lease{
		Endpoint:    result.Endpoint,
		APIKey:      result.APIKey,
		Model:       result.Model,
		Prompt:      result.Prompt,
		BillingMode: result.BillingMode,
		Tool: ToolOptions{
			Action:           result.Tool.Action,
			Size:             result.Tool.Size,
			Quality:          result.Tool.Quality,
			ForceSize:        result.Tool.ForceSize,
			ReasoningEffort:  result.Tool.Reasoning.Effort,
			ReasoningSummary: result.Tool.Reasoning.Summary,
		},
	}, nil
}

func (client *HTTPCallbacks) Complete(ctx context.Context, completion CompletionRequest) error {
	reader, writer := io.Pipe()
	form := multipart.NewWriter(writer)
	writeErr := make(chan error, 1)
	go func() {
		err := writeCompletionForm(form, completion)
		if closeErr := form.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = writer.CloseWithError(err)
		} else {
			_ = writer.Close()
		}
		writeErr <- err
	}()

	request, err := client.newRequest(ctx, http.MethodPost, "/api/internal/go-image2/complete", reader)
	if err != nil {
		_ = reader.Close()
		<-writeErr
		return err
	}
	request.Header.Set("Content-Type", form.FormDataContentType())
	response, err := client.http.Do(request)
	if err != nil {
		_ = reader.CloseWithError(err)
		<-writeErr
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_ = reader.Close()
		<-writeErr
		return callbackHTTPError(response)
	}
	if err := <-writeErr; err != nil {
		return err
	}
	return nil
}

func (client *HTTPCallbacks) Fail(ctx context.Context, failure FailureRequest) error {
	return client.postJSON(ctx, "/api/internal/go-image2/failed", map[string]any{
		"task_id": failure.TaskID, "user_id": failure.UserID, "error": failure.Error,
		"billing_mode": failure.BillingMode,
	})
}

func (client *HTTPCallbacks) postJSON(ctx context.Context, path string, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	request, err := client.newRequest(ctx, http.MethodPost, path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return callbackHTTPError(response)
	}
	return nil
}

func (client *HTTPCallbacks) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, client.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("X-Control-Plane-Secret", client.secret)
	return request, nil
}

func callbackHTTPError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, maxCallbackErrorBodyBytes))
	message := strings.TrimSpace(string(body))
	if len(message) > 512 {
		message = message[:512]
	}
	return &HTTPError{StatusCode: response.StatusCode, Message: message}
}

func writeCompletionForm(form *multipart.Writer, completion CompletionRequest) error {
	fields := map[string]string{
		"task_id":           completion.TaskID,
		"user_id":           completion.UserID,
		"model_id":          completion.ModelID,
		"prompt":            completion.Prompt,
		"size":              completion.Size,
		"output_resolution": completion.OutputResolution,
		"image_quality":     completion.ImageQuality,
		"conversation_id":   completion.ConversationID,
		"source":            completion.Source,
		"reference_count":   fmt.Sprintf("%d", completion.ReferenceCount),
		"completion_id":     completion.CompletionID,
		"billing_mode":      completion.BillingMode,
	}
	for _, name := range []string{
		"task_id", "user_id", "model_id", "prompt", "size", "output_resolution", "image_quality",
		"conversation_id", "source", "reference_count", "completion_id", "billing_mode",
	} {
		if err := form.WriteField(name, fields[name]); err != nil {
			return err
		}
	}
	image, err := form.CreateFormFile("image", "image.png")
	if err != nil {
		return err
	}
	_, err = image.Write(completion.Image)
	return err
}

type leaseResponse struct {
	Endpoint    string `json:"endpoint"`
	APIKey      string `json:"api_key"`
	Model       string `json:"model"`
	Prompt      string `json:"prompt"`
	BillingMode string `json:"billing_mode"`
	Tool        struct {
		Action    string `json:"action"`
		Size      string `json:"size"`
		Quality   string `json:"quality"`
		ForceSize bool   `json:"force_size"`
		Reasoning struct {
			Effort  string `json:"effort"`
			Summary string `json:"summary"`
		} `json:"reasoning"`
	} `json:"tool"`
}
