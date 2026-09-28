package image2worker

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"pixelscribe/go-controlplane/internal/image2"
	"pixelscribe/go-controlplane/internal/queue"
)

func TestProcessorCompletesLeasedShortcut(t *testing.T) {
	callbacks := &fakeCallbacks{
		input: []byte("reference-image"),
		lease: Lease{
			Endpoint: "https://image2.example/responses", APIKey: "provider-secret", Model: "gpt-5.5",
			Prompt: "server-approved prompt", BillingMode: "external_api_key",
			Tool: ToolOptions{Action: "edit", Size: "1536x1024", Quality: "high", ReasoningEffort: "low"},
		},
	}
	generator := &fakeGenerator{image: []byte("generated-image")}
	processor := newTestProcessor(t, callbacks, generator)

	if err := processor.Process(context.Background(), shortcutMessage(t, nil)); err != nil {
		t.Fatal(err)
	}
	if generator.calls != 1 {
		t.Fatalf("expected one provider call, got %d", generator.calls)
	}
	if generator.request.Prompt != "server-approved prompt" || generator.request.Size != "1536x1024" || generator.request.Quality != "high" || generator.request.Action != "edit" {
		t.Fatalf("unexpected leased image2 request %#v", generator.request)
	}
	if len(generator.request.Images) != 1 || string(generator.request.Images[0]) != "reference-image" {
		t.Fatalf("unexpected image inputs %#v", generator.request.Images)
	}
	if len(callbacks.completions) != 1 {
		t.Fatalf("expected completion callback, got %#v", callbacks.events)
	}
	completion := callbacks.completions[0]
	if completion.CompletionID != "go-image2:task-1:variant:1" || completion.BillingMode != "external_api_key" || string(completion.Image) != "generated-image" {
		t.Fatalf("unexpected completion %#v", completion)
	}
	if callbacks.leaseRequest.Source != "image2_shortcut" {
		t.Fatalf("expected source to be carried to the runtime lease, got %#v", callbacks.leaseRequest)
	}
	if len(callbacks.failures) != 0 {
		t.Fatalf("unexpected terminal failure %#v", callbacks.failures)
	}
	if strings.Join(callbacks.events, ",") != "input,prepare,lease,complete" {
		t.Fatalf("unexpected lifecycle order %#v", callbacks.events)
	}
}

func TestProcessorLeavesNormalClaimConflictPending(t *testing.T) {
	callbacks := &fakeCallbacks{input: []byte("reference-image"), leaseErr: ErrLeaseAlreadyClaimed}
	generator := &fakeGenerator{image: []byte("must-not-run")}
	processor := newTestProcessor(t, callbacks, generator)

	err := processor.Process(context.Background(), shortcutMessage(t, nil))
	if !errors.Is(err, ErrLeaseAlreadyClaimed) {
		t.Fatalf("expected the normal conflicting delivery to remain pending, got %v", err)
	}
	if generator.calls != 0 || len(callbacks.completions) != 0 || len(callbacks.failures) != 0 {
		t.Fatalf("claimed task must not be executed again: generator=%d complete=%d fail=%d", generator.calls, len(callbacks.completions), len(callbacks.failures))
	}
}

func TestProcessorFailsReclaimedMessageWithClaimedLease(t *testing.T) {
	callbacks := &fakeCallbacks{input: []byte("reference-image"), leaseErr: ErrLeaseAlreadyClaimed}
	generator := &fakeGenerator{image: []byte("must-not-run")}
	processor := newTestProcessor(t, callbacks, generator)
	message := shortcutMessage(t, nil)
	message.Reclaimed = true

	if err := processor.Process(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	if generator.calls != 0 || len(callbacks.completions) != 0 || len(callbacks.failures) != 1 {
		t.Fatalf("reclaimed claimed task must terminally fail without generating: generator=%d complete=%d fail=%d", generator.calls, len(callbacks.completions), len(callbacks.failures))
	}
	if !strings.Contains(callbacks.failures[0].Error, "interrupted") {
		t.Fatalf("unexpected reclaimed failure %#v", callbacks.failures[0])
	}
	if strings.Join(callbacks.events, ",") != "input,prepare,lease,fail" {
		t.Fatalf("unexpected reclaimed lifecycle order %#v", callbacks.events)
	}
}

func TestProcessorDefaultsGenerationTimeout(t *testing.T) {
	processor := newTestProcessor(t, &fakeCallbacks{}, &fakeGenerator{})
	if processor.config.GenerateTimeout != 10*time.Minute {
		t.Fatalf("unexpected default generation timeout %s", processor.config.GenerateTimeout)
	}
}

func TestProcessorAppliesGenerationTimeoutToProviderCall(t *testing.T) {
	callbacks := &fakeCallbacks{
		input: []byte("reference-image"),
		lease: Lease{Endpoint: "https://image2.example/responses", APIKey: "provider-secret", Model: "gpt-5.5", Prompt: "prompt"},
	}
	generator := &fakeGenerator{image: []byte("generated-image")}
	processor, err := NewProcessor(callbacks, generator, Config{
		GenerateTimeout: time.Second, CallbackRetries: 1, RetryDelay: time.Nanosecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	before := time.Now()
	if err := processor.Process(context.Background(), shortcutMessage(t, nil)); err != nil {
		t.Fatal(err)
	}
	if !generator.hasDeadline {
		t.Fatal("provider call did not receive a generation deadline")
	}
	if timeout := generator.deadline.Sub(before); timeout < 750*time.Millisecond || timeout > time.Second+250*time.Millisecond {
		t.Fatalf("unexpected provider generation deadline %s", timeout)
	}
}

func TestProcessorFailsTerminallyAfterProviderError(t *testing.T) {
	callbacks := &fakeCallbacks{
		input: []byte("reference-image"),
		lease: Lease{Endpoint: "https://image2.example/responses", APIKey: "provider-secret", Model: "gpt-5.5", Prompt: "prompt"},
	}
	generator := &fakeGenerator{err: errors.New("provider returned provider-secret in an error")}
	processor := newTestProcessor(t, callbacks, generator)

	if err := processor.Process(context.Background(), shortcutMessage(t, nil)); err != nil {
		t.Fatal(err)
	}
	if generator.calls != 1 || len(callbacks.completions) != 0 || len(callbacks.failures) != 1 {
		t.Fatalf("unexpected terminal provider failure state %#v", callbacks)
	}
	if strings.Contains(callbacks.failures[0].Error, "provider-secret") {
		t.Fatalf("provider credential escaped into failure callback: %q", callbacks.failures[0].Error)
	}
}

func TestProcessorRetriesIdempotentCompletion(t *testing.T) {
	callbacks := &fakeCallbacks{
		input:          []byte("reference-image"),
		lease:          Lease{Endpoint: "https://image2.example/responses", APIKey: "key", Model: "gpt-5.5", Prompt: "prompt"},
		completeErrors: []error{&HTTPError{StatusCode: 503, Message: "backend restarting"}},
	}
	generator := &fakeGenerator{image: []byte("generated-image")}
	processor := newTestProcessor(t, callbacks, generator)

	if err := processor.Process(context.Background(), shortcutMessage(t, nil)); err != nil {
		t.Fatal(err)
	}
	if generator.calls != 1 || len(callbacks.completions) != 2 || len(callbacks.failures) != 0 {
		t.Fatalf("expected one generation and retried completion, got generator=%d complete=%d fail=%d", generator.calls, len(callbacks.completions), len(callbacks.failures))
	}
}

func TestRequestFromLeaseDoesNotRestoreOmittedToolOptions(t *testing.T) {
	request := requestFromLease(
		job{Size: "1024x1024", ImageQuality: "auto", ForceSize: true},
		Lease{
			Endpoint: "https://image2.example/responses",
			APIKey:   "provider-secret",
			Model:    "gpt-5.5",
			Prompt:   "server-approved prompt",
			Tool:     ToolOptions{Action: "edit", ForceSize: false},
		},
		nil,
	)
	if request.Size != "" || request.Quality != "" || request.ForceSize {
		t.Fatalf("Go restored options Python intentionally omitted: %#v", request)
	}
}

func TestProcessorRejectsOversizedInputBeforeLease(t *testing.T) {
	callbacks := &fakeCallbacks{input: []byte("six-bytes")}
	generator := &fakeGenerator{image: []byte("must-not-run")}
	processor, err := NewProcessor(callbacks, generator, Config{
		MaxInputBytes: 5, CallbackRetries: 1, RetryDelay: time.Nanosecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := processor.Process(context.Background(), shortcutMessage(t, nil)); err != nil {
		t.Fatal(err)
	}
	if generator.calls != 0 || len(callbacks.failures) != 1 || callsWith(callbacks.events, "lease") != 0 {
		t.Fatalf("oversized input reached upstream lifecycle %#v", callbacks.events)
	}
}

func TestProcessorRejectsExactImageBase64Field(t *testing.T) {
	callbacks := &fakeCallbacks{}
	processor := newTestProcessor(t, callbacks, &fakeGenerator{})
	payload := map[string]any{
		"model_id": "image2",
		"prompt":   "queue prompt",
		"params": map[string]any{
			"source": "image2_shortcut", "n": 1, "enable_visual_review": false,
		},
		"image_base64": "legacy-base64",
	}
	if err := processor.Process(context.Background(), shortcutMessage(t, payload)); err != nil {
		t.Fatal(err)
	}
	if len(callbacks.failures) != 1 || callbacks.failures[0].Error != "invalid image2 queue job" {
		t.Fatalf("expected terminal legacy-payload failure, got %#v", callbacks.failures)
	}
}

func newTestProcessor(t *testing.T, callbacks *fakeCallbacks, generator *fakeGenerator) *Processor {
	t.Helper()
	processor, err := NewProcessor(callbacks, generator, Config{CallbackRetries: 3, RetryDelay: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	return processor
}

func shortcutMessage(t *testing.T, payload map[string]any) queue.StreamMessage {
	t.Helper()
	if payload == nil {
		payload = map[string]any{
			"model_id": "image2",
			"prompt":   "queue prompt",
			"params": map[string]any{
				"source": "image2_shortcut", "n": 1, "size": "1024x1024", "output_resolution": "1k",
				"image_quality": "auto", "force_size": true, "enable_visual_review": false,
			},
			"image_assets":     []any{map[string]any{"key": "assets/users/user-1/queue-inputs/task-1/00-source-image.png"}},
			"images_bytes_b64": []any{},
			"llm_model_id":     "",
			"vision_model_id":  "",
		}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return queue.StreamMessage{ID: "1-0", Stream: "queue:image2", Fields: map[string]string{
		"task_id": "task-1", "task_type": "generate", "user_id": "user-1", "payload": string(raw),
	}}
}

type fakeCallbacks struct {
	input          []byte
	lease          Lease
	leaseErr       error
	leaseRequest   LeaseRequest
	prepareErr     error
	inputErr       error
	completeErrors []error
	failErr        error
	events         []string
	completions    []CompletionRequest
	failures       []FailureRequest
}

func (callbacks *fakeCallbacks) FetchInput(_ context.Context, _ InputRequest) ([]byte, error) {
	callbacks.events = append(callbacks.events, "input")
	return callbacks.input, callbacks.inputErr
}

func (callbacks *fakeCallbacks) Prepare(_ context.Context, _ PrepareRequest) error {
	callbacks.events = append(callbacks.events, "prepare")
	return callbacks.prepareErr
}

func (callbacks *fakeCallbacks) Lease(_ context.Context, request LeaseRequest) (Lease, error) {
	callbacks.events = append(callbacks.events, "lease")
	callbacks.leaseRequest = request
	return callbacks.lease, callbacks.leaseErr
}

func (callbacks *fakeCallbacks) Complete(_ context.Context, completion CompletionRequest) error {
	callbacks.events = append(callbacks.events, "complete")
	callbacks.completions = append(callbacks.completions, completion)
	if len(callbacks.completeErrors) == 0 {
		return nil
	}
	err := callbacks.completeErrors[0]
	callbacks.completeErrors = callbacks.completeErrors[1:]
	return err
}

func (callbacks *fakeCallbacks) Fail(_ context.Context, failure FailureRequest) error {
	callbacks.events = append(callbacks.events, "fail")
	callbacks.failures = append(callbacks.failures, failure)
	return callbacks.failErr
}

type fakeGenerator struct {
	request     image2.Request
	image       []byte
	err         error
	calls       int
	hasDeadline bool
	deadline    time.Time
}

func (generator *fakeGenerator) Generate(ctx context.Context, request image2.Request) ([]byte, error) {
	generator.calls++
	generator.request = request
	generator.deadline, generator.hasDeadline = ctx.Deadline()
	return generator.image, generator.err
}

func callsWith(events []string, expected string) int {
	count := 0
	for _, event := range events {
		if event == expected {
			count++
		}
	}
	return count
}
