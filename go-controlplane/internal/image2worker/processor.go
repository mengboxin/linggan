// Package image2worker owns the narrow Go execution path for direct image2
// shortcuts. It intentionally leaves credits, assets, history, and user events
// in Python while the migration is in progress.
package image2worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"

	"pixelscribe/go-controlplane/internal/image2"
	"pixelscribe/go-controlplane/internal/queue"
)

const (
	defaultMaxInputs       = 8
	defaultMaxInputBytes   = 50 << 20
	defaultMaxOutputBytes  = 32 << 20
	defaultCallbackRetries = 3
	defaultGenerateTimeout = 10 * time.Minute
)

// ErrLeaseAlreadyClaimed means another worker already owns this task's single
// upstream image-generation attempt. A reclaimed delivery must first record a
// terminal failure, because its original consumer disappeared after acquiring
// the lock. A normal delivery stays pending: it may be an old worker whose PEL
// ownership was transferred while it was blocked before the lease call.
var ErrLeaseAlreadyClaimed = errors.New("image2 execution already claimed")

// Generator is satisfied by image2.Client and makes the processor testable
// without an actual upstream request.
type Generator interface {
	Generate(ctx context.Context, input image2.Request) ([]byte, error)
}

// Callbacks is the internal Python handoff. Lease is the only operation that
// grants model credentials and atomically claims the shared generate lock.
type Callbacks interface {
	FetchInput(ctx context.Context, request InputRequest) ([]byte, error)
	Prepare(ctx context.Context, request PrepareRequest) error
	Lease(ctx context.Context, request LeaseRequest) (Lease, error)
	Complete(ctx context.Context, request CompletionRequest) error
	Fail(ctx context.Context, request FailureRequest) error
}

type InputRequest struct {
	TaskID   string
	UserID   string
	Key      string
	MaxBytes int64
}

type PrepareRequest struct {
	TaskID      string
	UserID      string
	ModelID     string
	Progress    int
	BillingMode string
}

type LeaseRequest struct {
	TaskID         string
	UserID         string
	ModelID        string
	Prompt         string
	Source         string
	Size           string
	ImageQuality   string
	ForceSize      bool
	ReferenceCount int
	BillingMode    string
}

// Lease contains only an in-memory, short-lived provider configuration. None
// of these fields are persisted in Redis or logged by this package.
type Lease struct {
	Endpoint    string
	APIKey      string
	Model       string
	Prompt      string
	BillingMode string
	Tool        ToolOptions
}

type ToolOptions struct {
	Action           string
	Size             string
	Quality          string
	ForceSize        bool
	ReasoningEffort  string
	ReasoningSummary string
}

type CompletionRequest struct {
	TaskID           string
	UserID           string
	ModelID          string
	Prompt           string
	Size             string
	OutputResolution string
	ImageQuality     string
	ConversationID   string
	Source           string
	ReferenceCount   int
	CompletionID     string
	BillingMode      string
	Image            []byte
}

type FailureRequest struct {
	TaskID      string
	UserID      string
	Error       string
	BillingMode string
}

type Config struct {
	MaxInputs       int
	MaxInputBytes   int64
	MaxOutputBytes  int64
	GenerateTimeout time.Duration
	CallbackRetries int
	RetryDelay      time.Duration
}

type Processor struct {
	callbacks Callbacks
	generator Generator
	config    Config
}

func NewProcessor(callbacks Callbacks, generator Generator, config Config) (*Processor, error) {
	if callbacks == nil {
		return nil, errors.New("image2 callbacks are required")
	}
	if generator == nil {
		return nil, errors.New("image2 generator is required")
	}
	if config.MaxInputs <= 0 {
		config.MaxInputs = defaultMaxInputs
	}
	if config.MaxInputBytes <= 0 {
		config.MaxInputBytes = defaultMaxInputBytes
	}
	if config.MaxOutputBytes <= 0 {
		config.MaxOutputBytes = defaultMaxOutputBytes
	}
	if config.GenerateTimeout <= 0 {
		config.GenerateTimeout = defaultGenerateTimeout
	}
	if config.CallbackRetries <= 0 {
		config.CallbackRetries = defaultCallbackRetries
	}
	if config.RetryDelay <= 0 {
		config.RetryDelay = 250 * time.Millisecond
	}
	return &Processor{callbacks: callbacks, generator: generator, config: config}, nil
}

// Process only handles the image2-shortcut contract written to queue:image2.
// It returns nil only after a terminal Python callback is durable, allowing the
// generic Streams worker to ACK the message.
func (processor *Processor) Process(ctx context.Context, message queue.StreamMessage) error {
	job, err := parseJob(message)
	if err != nil {
		if job.TaskID == "" || job.UserID == "" {
			return fmt.Errorf("invalid image2 queue job: %w", err)
		}
		return processor.failTerminal(ctx, job, "invalid image2 queue job")
	}
	if len(job.Assets) > processor.config.MaxInputs {
		return processor.failTerminal(ctx, job, "too many image2 reference images")
	}

	images, err := processor.loadInputs(ctx, job)
	if err != nil {
		if isRetryable(err) {
			return fmt.Errorf("load image2 input: %w", err)
		}
		return processor.failTerminal(ctx, job, "image2 reference image is unavailable")
	}

	if err := processor.retry(ctx, func() error {
		return processor.callbacks.Prepare(ctx, PrepareRequest{
			TaskID: job.TaskID, UserID: job.UserID, ModelID: job.ModelID, Progress: 20, BillingMode: job.BillingMode,
		})
	}); err != nil {
		if isRetryable(err) {
			return fmt.Errorf("prepare image2 task: %w", err)
		}
		return processor.failTerminal(ctx, job, "image2 task preparation was rejected")
	}

	lease, err := processor.lease(ctx, job)
	if errors.Is(err, ErrLeaseAlreadyClaimed) {
		if message.Reclaimed {
			// A prior consumer claimed the one-time generation lock and then left
			// this Streams entry pending. Calling image2 again could charge or
			// generate twice, so make the interruption visible and let Worker ACK
			// only after Python persists the failed terminal state.
			return processor.failTerminal(ctx, job, "image2 execution was interrupted before its result could be finalized")
		}
		// Do not ACK from an old consumer. Redis permits any group member to
		// acknowledge an entry, which could otherwise erase the new owner's PEL
		// record while it is still making the one allowed upstream call.
		return fmt.Errorf("image2 execution is already claimed: %w", ErrLeaseAlreadyClaimed)
	}
	if err != nil {
		if isRetryable(err) {
			return fmt.Errorf("obtain image2 runtime lease: %w", err)
		}
		return processor.failTerminal(ctx, job, "image2 runtime lease was rejected")
	}
	// The lease resolves an omitted billing mode against Python's authoritative
	// user record. Keep that decision for all terminal callbacks.
	job.BillingMode = nonEmpty(lease.BillingMode, job.BillingMode)
	if err := validateLease(lease); err != nil {
		return processor.failTerminal(ctx, job, "image2 runtime configuration is invalid")
	}

	request := requestFromLease(job, lease, images)
	request.MaxOutputBytes = processor.config.MaxOutputBytes
	// Bound the untrusted upstream stream without cancelling the callback
	// context. That leaves enough time to persist a terminal failure after a
	// provider timeout, and keeps the 15-minute PEL reclaim threshold safely
	// above any active image2 call.
	generationContext, cancelGeneration := context.WithTimeout(ctx, processor.config.GenerateTimeout)
	image, err := processor.generator.Generate(generationContext, request)
	cancelGeneration()
	if err != nil {
		// The lease has claimed task:<id>:generate_started. Even a network
		// error is ambiguous from a billing perspective, so do not reissue the
		// upstream call from a reclaimed Streams message.
		return processor.failTerminal(ctx, job, safeFailureMessage("image2 generation failed", err, lease.APIKey))
	}
	if len(image) == 0 || int64(len(image)) > processor.config.MaxOutputBytes {
		return processor.failTerminal(ctx, job, "image2 returned an invalid image")
	}

	completion := CompletionRequest{
		TaskID:           job.TaskID,
		UserID:           job.UserID,
		ModelID:          job.ModelID,
		Prompt:           lease.Prompt,
		Size:             job.Size,
		OutputResolution: job.OutputResolution,
		ImageQuality:     job.ImageQuality,
		ConversationID:   job.ConversationID,
		Source:           job.Source,
		ReferenceCount:   len(job.Assets),
		CompletionID:     "go-image2:" + job.TaskID + ":variant:1",
		BillingMode:      job.BillingMode,
		Image:            image,
	}
	if err := processor.retry(ctx, func() error {
		return processor.callbacks.Complete(ctx, completion)
	}); err != nil {
		// Completion is idempotent by completion_id. If it cannot be made
		// durable, record a terminal failure rather than risking a second model
		// call after the execution lease was claimed.
		if failureErr := processor.failTerminal(ctx, job, "image2 result could not be finalized"); failureErr != nil {
			return fmt.Errorf("image2 completion callback failed: %w", failureErr)
		}
	}
	return nil
}

func (processor *Processor) loadInputs(ctx context.Context, job job) ([][]byte, error) {
	images := make([][]byte, 0, len(job.Assets))
	var total int64
	for _, asset := range job.Assets {
		data, err := processor.fetchInput(ctx, InputRequest{
			TaskID: job.TaskID, UserID: job.UserID, Key: asset.Key,
			MaxBytes: processor.config.MaxInputBytes - total,
		})
		if err != nil {
			return nil, err
		}
		total += int64(len(data))
		if len(data) == 0 || total > processor.config.MaxInputBytes {
			return nil, errors.New("image2 input exceeds configured limits")
		}
		images = append(images, data)
	}
	return images, nil
}

func (processor *Processor) fetchInput(ctx context.Context, request InputRequest) ([]byte, error) {
	var data []byte
	err := processor.retry(ctx, func() error {
		var err error
		data, err = processor.callbacks.FetchInput(ctx, request)
		return err
	})
	return data, err
}

func (processor *Processor) lease(ctx context.Context, job job) (Lease, error) {
	// Lease atomically claims the shared generate execution lock. Retrying an
	// ambiguous network failure could turn an issued lease into a 409 on the
	// second request, so it is deliberately attempted once. The message stays
	// pending for operator recovery if the lease endpoint is unavailable.
	return processor.callbacks.Lease(ctx, LeaseRequest{
		TaskID: job.TaskID, UserID: job.UserID, ModelID: job.ModelID,
		Prompt: job.Prompt, Source: job.Source, Size: job.Size, ImageQuality: job.ImageQuality,
		ForceSize: job.ForceSize, ReferenceCount: len(job.Assets), BillingMode: job.BillingMode,
	})
}

func (processor *Processor) failTerminal(ctx context.Context, job job, message string) error {
	err := processor.retry(ctx, func() error {
		return processor.callbacks.Fail(ctx, FailureRequest{
			TaskID: job.TaskID, UserID: job.UserID, Error: truncate(message, 1000), BillingMode: job.BillingMode,
		})
	})
	if err != nil {
		return fmt.Errorf("record terminal image2 failure: %w", err)
	}
	return nil
}

func (processor *Processor) retry(ctx context.Context, operation func() error) error {
	var last error
	for attempt := 0; attempt < processor.config.CallbackRetries; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		last = operation()
		if last == nil || !isRetryable(last) || attempt+1 == processor.config.CallbackRetries {
			return last
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(processor.config.RetryDelay * time.Duration(attempt+1)):
		}
	}
	return last
}

type job struct {
	TaskID           string
	UserID           string
	BillingMode      string
	ModelID          string
	Prompt           string
	Size             string
	OutputResolution string
	ImageQuality     string
	ForceSize        bool
	ConversationID   string
	Source           string
	Assets           []asset
}

type asset struct{ Key string }

func parseJob(message queue.StreamMessage) (job, error) {
	parsed := job{TaskID: strings.TrimSpace(message.Fields["task_id"]), UserID: strings.TrimSpace(message.Fields["user_id"]), BillingMode: strings.TrimSpace(message.Fields["billing_mode"])}
	if strings.TrimSpace(message.Fields["task_type"]) != "generate" {
		return parsed, errors.New("queue:image2 only accepts generate tasks")
	}
	if parsed.TaskID == "" || parsed.UserID == "" {
		return parsed, errors.New("task_id and user_id are required")
	}
	rawPayload := message.Fields["payload"]
	var payload map[string]any
	if err := json.Unmarshal([]byte(rawPayload), &payload); err != nil {
		return parsed, errors.New("payload is not valid JSON")
	}
	if legacyImagePayload(payload) {
		return parsed, errors.New("queue payload contains image bytes instead of asset references")
	}
	parsed.ModelID = text(payload["model_id"])
	parsed.Prompt = text(payload["prompt"])
	params, ok := payload["params"].(map[string]any)
	if !ok {
		return parsed, errors.New("generate params are required")
	}
	parsed.Source = text(params["source"])
	if !strings.HasSuffix(parsed.Source, "image2_shortcut") {
		return parsed, errors.New("task is not an image2 shortcut")
	}
	if number(params["n"], 1) != 1 || text(payload["llm_model_id"]) != "" || text(payload["vision_model_id"]) != "" {
		return parsed, errors.New("task does not match the single-call image2 contract")
	}
	if truthy(params["enable_visual_review"]) {
		return parsed, errors.New("image2 shortcut must not enable visual review")
	}
	parsed.Size = nonEmpty(text(params["size"]), "1024x1024")
	parsed.OutputResolution = nonEmpty(text(params["output_resolution"]), "1k")
	parsed.ImageQuality = nonEmpty(text(params["image_quality"]), "auto")
	parsed.ForceSize = truthy(params["force_size"])
	parsed.ConversationID = text(params["conversation_id"])
	if parsed.ModelID == "" || parsed.Prompt == "" {
		return parsed, errors.New("model_id and prompt are required")
	}
	assets, err := parseAssets(payload["image_assets"])
	if err != nil {
		return parsed, err
	}
	parsed.Assets = assets
	return parsed, nil
}

func parseAssets(value any) ([]asset, error) {
	if value == nil {
		return []asset{}, nil
	}
	items, ok := value.([]any)
	if !ok {
		return nil, errors.New("image_assets must be an array")
	}
	assets := make([]asset, 0, len(items))
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, errors.New("image asset reference is invalid")
		}
		key := strings.TrimSpace(text(entry["key"]))
		if key == "" || strings.Contains(key, "://") || strings.HasPrefix(key, "/") {
			return nil, errors.New("image asset key is invalid")
		}
		assets = append(assets, asset{Key: key})
	}
	return assets, nil
}

func legacyImagePayload(payload map[string]any) bool {
	for key, value := range payload {
		lower := strings.ToLower(key)
		if (lower == "images_bytes_b64" || lower == "image_base64" || lower == "image_b64" ||
			strings.HasSuffix(lower, "_image_bytes") || strings.HasSuffix(lower, "_image_base64") || strings.HasSuffix(lower, "_image_b64")) && hasValue(value) {
			return true
		}
		switch nested := value.(type) {
		case map[string]any:
			if legacyImagePayload(nested) {
				return true
			}
		case []any:
			for _, item := range nested {
				if entry, ok := item.(map[string]any); ok && legacyImagePayload(entry) {
					return true
				}
			}
		}
	}
	return false
}

func requestFromLease(job job, lease Lease, images [][]byte) image2.Request {
	return image2.Request{
		Endpoint: lease.Endpoint, APIKey: lease.APIKey, Model: lease.Model, Prompt: lease.Prompt,
		// Python resolves optional image-tool fields in the lease. Do not fall
		// back to raw job values here or Go can add a field Python omitted.
		Images: images, Action: lease.Tool.Action, Size: lease.Tool.Size, Quality: lease.Tool.Quality, ForceSize: lease.Tool.ForceSize,
		ReasoningEffort: lease.Tool.ReasoningEffort, ReasoningSummary: lease.Tool.ReasoningSummary,
	}
}

func validateLease(lease Lease) error {
	if strings.TrimSpace(lease.Endpoint) == "" || strings.TrimSpace(lease.APIKey) == "" || strings.TrimSpace(lease.Model) == "" || strings.TrimSpace(lease.Prompt) == "" {
		return errors.New("lease is missing required runtime configuration")
	}
	return nil
}

func isRetryable(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	var callbackError *HTTPError
	if errors.As(err, &callbackError) {
		return callbackError.Retryable()
	}
	var networkError net.Error
	if errors.As(err, &networkError) {
		return true
	}
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, context.DeadlineExceeded)
}

func safeFailureMessage(prefix string, err error, apiKey string) string {
	message := prefix
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		detail := strings.ReplaceAll(err.Error(), apiKey, "[redacted]")
		message += ": " + detail
	}
	return truncate(message, 1000)
}

func text(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func truthy(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	default:
		return false
	}
}

func number(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case json.Number:
		parsed, err := typed.Int64()
		if err == nil {
			return int(parsed)
		}
	case int:
		return typed
	}
	return fallback
}

func hasValue(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(typed) != ""
	case []any:
		return len(typed) > 0
	default:
		return true
	}
}

func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func truncate(value string, maximum int) string {
	if len(value) <= maximum {
		return value
	}
	return value[:maximum]
}
