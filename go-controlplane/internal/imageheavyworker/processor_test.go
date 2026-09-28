package imageheavyworker

import (
	"context"
	"errors"
	"testing"

	"pixelscribe/go-controlplane/internal/queue"
)

func TestParseJobRequiresAssetReferences(t *testing.T) {
	message := queue.StreamMessage{Fields: map[string]string{
		"task_id": "task-1", "user_id": "user-1", "task_type": "touch-replace",
		"payload": `{"model_id":"inpainting-flux-fill","mode":"replace","prompt":"replace","image_asset":{"key":"assets/users/user-1/input.png"},"mask_asset":{"key":"assets/users/user-1/mask.png"}}`,
	}}
	job, err := parseJob(message)
	if err != nil || job.Image.Key == "" || job.Mask.Key == "" {
		t.Fatalf("expected asset-backed job, job=%#v err=%v", job, err)
	}

	message.Fields["payload"] = `{"model_id":"inpainting-flux-fill","mode":"replace","prompt":"replace","image_bytes":"legacy"}`
	if _, err := parseJob(message); err == nil {
		t.Fatal("expected legacy binary payload to be rejected")
	}
}

func TestProcessorCompletesOneHeavyTask(t *testing.T) {
	callbacks := &fakeCallbacks{lease: Lease{Endpoint: "https://provider.example", APIKey: "secret", Prompt: "replace", Strength: .95, BillingMode: "platform_credits"}}
	processor, err := NewProcessor(callbacks, fakeGenerator{image: []byte("png")}, Config{})
	if err != nil {
		t.Fatal(err)
	}
	message := queue.StreamMessage{Fields: map[string]string{
		"task_id": "task-1", "user_id": "user-1", "task_type": "touch-replace",
		"payload": `{"model_id":"inpainting-flux-fill","mode":"replace","prompt":"replace","element_id":"el-1","image_asset":{"key":"assets/users/user-1/input.png"},"mask_asset":{"key":"assets/users/user-1/mask.png"}}`,
	}}
	if err := processor.Process(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	if callbacks.completed == nil || callbacks.completed.CompletionID != "go-image-heavy:task-1" {
		t.Fatalf("unexpected completion %#v", callbacks.completed)
	}
}

type fakeCallbacks struct {
	lease     Lease
	completed *CompletionRequest
}

func (f *fakeCallbacks) FetchInput(context.Context, InputRequest) ([]byte, error) {
	return []byte("input"), nil
}
func (f *fakeCallbacks) Lease(context.Context, LeaseRequest) (Lease, error) { return f.lease, nil }
func (f *fakeCallbacks) Complete(_ context.Context, request CompletionRequest) error {
	f.completed = &request
	return nil
}
func (f *fakeCallbacks) Fail(context.Context, FailureRequest) error {
	return errors.New("unexpected failure")
}

type fakeGenerator struct{ image []byte }

func (f fakeGenerator) Generate(context.Context, GenerateRequest) ([]byte, error) {
	return f.image, nil
}
