package imageheavyworker

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"pixelscribe/go-controlplane/internal/queue"
)

const (
	defaultMaxInputBytes  = 50 << 20
	defaultMaxOutputBytes = 32 << 20
	defaultTimeout        = 8 * time.Minute
)

var ErrLeaseAlreadyClaimed = errors.New("image heavy execution already claimed")

type InputRequest struct {
	TaskID, UserID, Key string
	MaxBytes            int64
}
type LeaseRequest struct{ TaskID, UserID, ModelID, Prompt, Mode, TargetColor, BillingMode string }
type Lease struct {
	Endpoint, APIKey, Prompt, BillingMode string
	Strength                              float64
}
type CompletionRequest struct {
	TaskID, UserID, ModelID, Prompt, Mode, ElementID, CompletionID, BillingMode string
	Image                                                                       []byte
}
type FailureRequest struct{ TaskID, UserID, Error, BillingMode string }
type Callbacks interface {
	FetchInput(context.Context, InputRequest) ([]byte, error)
	Lease(context.Context, LeaseRequest) (Lease, error)
	Complete(context.Context, CompletionRequest) error
	Fail(context.Context, FailureRequest) error
}
type Generator interface {
	Generate(context.Context, GenerateRequest) ([]byte, error)
}
type GenerateRequest struct {
	Endpoint, APIKey, Prompt string
	Strength                 float64
	Image, Mask              []byte
	MaxOutputBytes           int64
}
type Config struct {
	MaxInputBytes, MaxOutputBytes int64
	Timeout, RetryDelay           time.Duration
	CallbackRetries               int
}
type Processor struct {
	callbacks Callbacks
	generator Generator
	config    Config
}

func NewProcessor(callbacks Callbacks, generator Generator, config Config) (*Processor, error) {
	if callbacks == nil || generator == nil {
		return nil, errors.New("image heavy callbacks and generator are required")
	}
	if config.MaxInputBytes <= 0 {
		config.MaxInputBytes = defaultMaxInputBytes
	}
	if config.MaxOutputBytes <= 0 {
		config.MaxOutputBytes = defaultMaxOutputBytes
	}
	if config.Timeout <= 0 {
		config.Timeout = defaultTimeout
	}
	if config.CallbackRetries <= 0 {
		config.CallbackRetries = 3
	}
	if config.RetryDelay <= 0 {
		config.RetryDelay = 250 * time.Millisecond
	}
	return &Processor{callbacks: callbacks, generator: generator, config: config}, nil
}

func (p *Processor) Process(ctx context.Context, message queue.StreamMessage) error {
	job, err := parseJob(message)
	if err != nil {
		if job.TaskID == "" || job.UserID == "" {
			return err
		}
		return p.fail(ctx, job, "invalid image edit queue job")
	}
	image, err := p.fetch(ctx, job.Image)
	if err != nil {
		return p.failOrRetry(ctx, job, "image edit input unavailable", err)
	}
	mask, err := p.fetch(ctx, job.Mask)
	if err != nil {
		return p.failOrRetry(ctx, job, "image edit mask unavailable", err)
	}
	lease, err := p.callbacks.Lease(ctx, LeaseRequest{TaskID: job.TaskID, UserID: job.UserID, ModelID: job.ModelID, Prompt: job.Prompt, Mode: job.Mode, TargetColor: job.TargetColor, BillingMode: job.BillingMode})
	if errors.Is(err, ErrLeaseAlreadyClaimed) {
		if message.Reclaimed {
			return p.fail(ctx, job, "image edit execution was interrupted before finalization")
		}
		return err
	}
	if err != nil {
		return p.failOrRetry(ctx, job, "image edit runtime lease failed", err)
	}
	if strings.TrimSpace(lease.Endpoint) == "" || strings.TrimSpace(lease.APIKey) == "" || strings.TrimSpace(lease.Prompt) == "" {
		return p.fail(ctx, job, "image edit runtime configuration is invalid")
	}
	genCtx, cancel := context.WithTimeout(ctx, p.config.Timeout)
	result, err := p.generator.Generate(genCtx, GenerateRequest{Endpoint: lease.Endpoint, APIKey: lease.APIKey, Prompt: lease.Prompt, Strength: lease.Strength, Image: image, Mask: mask, MaxOutputBytes: p.config.MaxOutputBytes})
	cancel()
	if err != nil {
		return p.fail(ctx, job, safeFailure("image edit generation failed", err, lease.APIKey))
	}
	if len(result) == 0 || int64(len(result)) > p.config.MaxOutputBytes {
		return p.fail(ctx, job, "image edit returned an invalid image")
	}
	completion := CompletionRequest{TaskID: job.TaskID, UserID: job.UserID, ModelID: job.ModelID, Prompt: lease.Prompt, Mode: job.Mode, ElementID: job.ElementID, CompletionID: "go-image-heavy:" + job.TaskID, BillingMode: nonEmpty(lease.BillingMode, job.BillingMode), Image: result}
	if err := p.retry(ctx, func() error { return p.callbacks.Complete(ctx, completion) }); err != nil {
		return p.fail(ctx, job, "image edit result could not be finalized")
	}
	return nil
}

func (p *Processor) fetch(ctx context.Context, asset asset) ([]byte, error) {
	var data []byte
	err := p.retry(ctx, func() error {
		var e error
		data, e = p.callbacks.FetchInput(ctx, InputRequest{TaskID: asset.TaskID, UserID: asset.UserID, Key: asset.Key, MaxBytes: p.config.MaxInputBytes})
		return e
	})
	return data, err
}
func (p *Processor) failOrRetry(ctx context.Context, job job, prefix string, err error) error {
	if retryable(err) {
		return fmt.Errorf("%s: %w", prefix, err)
	}
	return p.fail(ctx, job, prefix)
}
func (p *Processor) fail(ctx context.Context, job job, message string) error {
	return p.retry(ctx, func() error {
		return p.callbacks.Fail(ctx, FailureRequest{TaskID: job.TaskID, UserID: job.UserID, Error: message, BillingMode: job.BillingMode})
	})
}
func (p *Processor) retry(ctx context.Context, op func() error) error {
	var last error
	for i := 0; i < p.config.CallbackRetries; i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		last = op()
		if last == nil || !retryable(last) || i+1 == p.config.CallbackRetries {
			return last
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(p.config.RetryDelay * time.Duration(i+1)):
		}
	}
	return last
}

type job struct {
	TaskID, UserID, BillingMode, ModelID, Prompt, Mode, TargetColor, ElementID string
	Image, Mask                                                                asset
}
type asset struct{ TaskID, UserID, Key string }

func parseJob(message queue.StreamMessage) (job, error) {
	parsed := job{TaskID: strings.TrimSpace(message.Fields["task_id"]), UserID: strings.TrimSpace(message.Fields["user_id"]), BillingMode: strings.TrimSpace(message.Fields["billing_mode"])}
	taskType := strings.TrimSpace(message.Fields["task_type"])
	if taskType != "touch-replace" && taskType != "touch-recolor" {
		return parsed, errors.New("queue:image-heavy only accepts touch replace/recolor")
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(message.Fields["payload"]), &payload); err != nil {
		return parsed, errors.New("queue payload is not valid JSON")
	}
	if legacy(payload) {
		return parsed, errors.New("queue payload contains image bytes")
	}
	parsed.ModelID, parsed.Prompt, parsed.Mode, parsed.TargetColor, parsed.ElementID = text(payload["model_id"]), text(payload["prompt"]), text(payload["mode"]), text(payload["target_color"]), text(payload["element_id"])
	if parsed.Mode == "" {
		parsed.Mode = strings.TrimPrefix(taskType, "touch-")
	}
	if parsed.TaskID == "" || parsed.UserID == "" || parsed.ModelID == "" {
		return parsed, errors.New("task, user, and model are required")
	}
	parsed.Image, _ = parseAsset(payload["image_asset"], parsed.TaskID, parsed.UserID)
	parsed.Mask, _ = parseAsset(payload["mask_asset"], parsed.TaskID, parsed.UserID)
	if parsed.Image.Key == "" || parsed.Mask.Key == "" {
		return parsed, errors.New("image and mask asset references are required")
	}
	return parsed, nil
}
func parseAsset(value any, taskID, userID string) (asset, error) {
	entry, ok := value.(map[string]any)
	if !ok {
		return asset{}, errors.New("asset reference is invalid")
	}
	key := text(entry["key"])
	if key == "" || strings.Contains(key, "://") || strings.HasPrefix(key, "/") {
		return asset{}, errors.New("asset key is invalid")
	}
	return asset{TaskID: taskID, UserID: userID, Key: key}, nil
}
func legacy(payload map[string]any) bool {
	for key, value := range payload {
		lower := strings.ToLower(key)
		if (lower == "image_bytes" || lower == "mask_bytes" || strings.HasSuffix(lower, "_base64") || strings.HasSuffix(lower, "_b64")) && hasValue(value) {
			return true
		}
		if nested, ok := value.(map[string]any); ok && legacy(nested) {
			return true
		}
	}
	return false
}
func hasValue(value any) bool {
	if value == nil {
		return false
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text) != ""
	}
	return true
}
func text(value any) string { text, _ := value.(string); return strings.TrimSpace(text) }
func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
func retryable(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.Retryable()
	}
	var network net.Error
	return errors.As(err, &network) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, context.DeadlineExceeded)
}
func safeFailure(prefix string, err error, secret string) string {
	return strings.ReplaceAll(prefix+": "+err.Error(), secret, "[redacted]")
}

type ReplicateGenerator struct{ client *http.Client }

func NewReplicateGenerator(client *http.Client) *ReplicateGenerator {
	if client == nil {
		client = &http.Client{}
	}
	return &ReplicateGenerator{client: client}
}
func (g *ReplicateGenerator) Generate(ctx context.Context, in GenerateRequest) ([]byte, error) {
	payload := map[string]any{"input": map[string]any{"image": "data:image/png;base64," + base64.StdEncoding.EncodeToString(in.Image), "mask": "data:image/png;base64," + base64.StdEncoding.EncodeToString(in.Mask), "prompt": in.Prompt, "strength": in.Strength}}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, in.Endpoint, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Token "+in.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Prefer", "wait")
	resp, err := g.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("provider status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var data map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&data); err != nil {
		return nil, err
	}
	getURL, _ := data["urls"].(map[string]any)
	pollURL, _ := getURL["get"].(string)
	for attempt := 0; ; attempt++ {
		status, _ := data["status"].(string)
		if status == "succeeded" {
			break
		}
		if status == "failed" || status == "canceled" {
			return nil, fmt.Errorf("provider task %s", status)
		}
		if pollURL == "" || attempt >= 120 {
			return nil, errors.New("provider task timed out")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
		pollReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
		pollReq.Header.Set("Authorization", "Token "+in.APIKey)
		pollResp, e := g.client.Do(pollReq)
		if e != nil {
			return nil, e
		}
		e = json.NewDecoder(io.LimitReader(pollResp.Body, 1<<20)).Decode(&data)
		pollResp.Body.Close()
		if e != nil {
			return nil, e
		}
	}
	output := data["output"]
	if list, ok := output.([]any); ok && len(list) > 0 {
		output = list[0]
	}
	outputURL, ok := output.(string)
	if !ok || outputURL == "" {
		return nil, errors.New("provider returned no image")
	}
	if strings.HasPrefix(outputURL, "data:image") {
		comma := strings.IndexByte(outputURL, ',')
		if comma < 0 {
			return nil, errors.New("provider returned invalid image data")
		}
		return base64.StdEncoding.DecodeString(outputURL[comma+1:])
	}
	dlReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, outputURL, nil)
	dlResp, err := g.client.Do(dlReq)
	if err != nil {
		return nil, err
	}
	defer dlResp.Body.Close()
	if dlResp.StatusCode < 200 || dlResp.StatusCode >= 300 {
		return nil, fmt.Errorf("provider image download status=%d", dlResp.StatusCode)
	}
	limit := in.MaxOutputBytes + 1
	result, err := io.ReadAll(io.LimitReader(dlResp.Body, limit))
	if err != nil {
		return nil, err
	}
	if int64(len(result)) >= limit {
		return nil, errors.New("provider image exceeds output limit")
	}
	return result, nil
}
