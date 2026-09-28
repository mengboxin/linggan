package main

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestValidateEnqueueRequestRejectsUnknownExecutionTarget(t *testing.T) {
	err := validateEnqueueRequest(enqueueRequest{
		TaskID: "task-1", TaskType: "generate", UserID: "user-1", ExecutionTarget: "python-worker", Payload: map[string]any{},
	})
	if err == nil {
		t.Fatal("expected unknown execution target to be rejected")
	}
}

func TestValidateEnqueueRequestAcceptsGoImage2GenerateTarget(t *testing.T) {
	err := validateEnqueueRequest(enqueueRequest{
		TaskID: "task-1", TaskType: "generate", UserID: "user-1", ExecutionTarget: "go-image2", Payload: map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestImage2ConsumerNameIsUniquePerProcessByDefault(t *testing.T) {
	t.Setenv("GO_IMAGE2_WORKER_CONSUMER", "")
	consumer := image2ConsumerName()
	if !strings.HasSuffix(consumer, "-"+strconv.Itoa(os.Getpid())) {
		t.Fatalf("default consumer name must include pid, got %q", consumer)
	}
}

func TestEnvOrDefaultUsesLoopbackFallback(t *testing.T) {
	t.Setenv("GO_CONTROL_PLANE_LISTEN_ADDR", "")
	if got := envOrDefault("GO_CONTROL_PLANE_LISTEN_ADDR", "127.0.0.1:8082"); got != "127.0.0.1:8082" {
		t.Fatalf("unexpected fallback address %q", got)
	}
	t.Setenv("GO_CONTROL_PLANE_LISTEN_ADDR", " :8082 ")
	if got := envOrDefault("GO_CONTROL_PLANE_LISTEN_ADDR", "127.0.0.1:8082"); got != ":8082" {
		t.Fatalf("unexpected configured address %q", got)
	}
}
