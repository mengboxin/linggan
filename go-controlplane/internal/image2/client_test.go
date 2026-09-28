package image2

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGenerateWithReferencesSendsCanonicalJSONPayload(t *testing.T) {
	input := Request{
		APIKey:    "test-key",
		Model:     "image2",
		Prompt:    "replace the sky",
		Images:    [][]byte{[]byte("input")},
		Size:      "1536x1024",
		ForceSize: true,
	}
	want, err := json.Marshal(buildPayload(input))
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(body, want) {
			t.Fatalf("image2 request body differs from canonical JSON\nwant: %s\n got: %s", want, body)
		}
		if request.ContentLength != int64(len(want)) {
			t.Fatalf("unexpected content length: got %d want %d", request.ContentLength, len(want))
		}
		if len(request.TransferEncoding) != 0 {
			t.Fatalf("unexpected transfer encoding: %v", request.TransferEncoding)
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"image_generation_call\",\"result\":\"aW1hZ2UtYnl0ZXM=\"}]}}\n\n")
	}))
	defer server.Close()

	input.Endpoint = server.URL
	image, err := NewClient(server.Client()).Generate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if string(image) != "image-bytes" {
		t.Fatalf("unexpected image %q", image)
	}
}

func TestGenerateMatchesResponsesImageSSEContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("missing bearer token")
		}
		if request.ContentLength <= 0 {
			t.Fatal("streamed image request must retain a fixed content length")
		}
		var payload map[string]any
		body, _ := io.ReadAll(request.Body)
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("streamed request was not JSON: %v; body=%s", err, body)
		}
		tools, _ := payload["tools"].([]any)
		tool, _ := tools[0].(map[string]any)
		if tool["type"] != "image_generation" || tool["action"] != "edit" {
			t.Fatalf("unexpected request tool %#v", tool)
		}
		input, _ := payload["input"].([]any)
		message, _ := input[0].(map[string]any)
		content, _ := message["content"].([]any)
		image, _ := content[1].(map[string]any)
		if image["image_url"] != "data:image/png;base64,aW5wdXQ=" {
			t.Fatalf("unexpected streamed input image %#v", image)
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"image_generation_call\",\"result\":\"aW1hZ2UtYnl0ZXM=\"}]}}\n\n")
		_, _ = io.WriteString(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()

	image, err := NewClient(server.Client()).Generate(context.Background(), Request{
		Endpoint: server.URL, APIKey: "test-key", Model: "image2", Prompt: "replace the sky", Images: [][]byte{[]byte("input")},
		Size: "1536x1024", ForceSize: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(image) != "image-bytes" {
		t.Fatalf("unexpected image %q", image)
	}
}

func TestParseSSEImageRejectsMissingImage(t *testing.T) {
	_, err := parseSSEImage(strings.NewReader("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n"), 0)
	if err == nil {
		t.Fatal("expected missing image error")
	}
}

func TestParseSSEImageRespectsOutputLimit(t *testing.T) {
	_, err := parseSSEImage(strings.NewReader("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"image_generation_call\",\"result\":\"aW1hZ2UtYnl0ZXM=\"}]}}\n\n"), 4)
	if err == nil || !strings.Contains(err.Error(), "output limit") {
		t.Fatalf("expected output limit error, got %v", err)
	}
}
