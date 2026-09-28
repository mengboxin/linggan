package image2worker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPCallbacksLeaseSendsSource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/internal/go-image2/lease" {
			t.Fatalf("unexpected lease path %q", request.URL.Path)
		}
		if request.Header.Get("X-Control-Plane-Secret") != "test-secret" {
			t.Fatal("lease request did not include the internal secret")
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if payload["source"] != "desktop_image2_shortcut" {
			t.Fatalf("unexpected lease source %#v", payload["source"])
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"endpoint":"https://image2.example/responses","api_key":"provider-secret","model":"image2","prompt":"server prompt","tool":{"reasoning":{}}}`))
	}))
	defer server.Close()

	callbacks, err := NewHTTPCallbacks(server.URL, "test-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	lease, err := callbacks.Lease(context.Background(), LeaseRequest{
		TaskID: "task-1", UserID: "user-1", ModelID: "image2", Prompt: "expand the frame",
		Source: "desktop_image2_shortcut",
	})
	if err != nil {
		t.Fatal(err)
	}
	if lease.Prompt != "server prompt" {
		t.Fatalf("unexpected lease %#v", lease)
	}
}
