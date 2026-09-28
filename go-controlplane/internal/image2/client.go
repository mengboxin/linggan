// Package image2 implements the OpenAI Responses image-generation protocol
// used by the platform's single image2 model.
package image2

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const maxSSELineBytes = 64 * 1024 * 1024

type Doer interface {
	Do(*http.Request) (*http.Response, error)
}

type Client struct {
	http Doer
}

type Request struct {
	Endpoint string
	APIKey   string
	Model    string
	Prompt   string
	Images   [][]byte
	// Action is normally inferred from Images, but the short-lived runtime
	// lease may require an explicit Responses image-generation action.
	Action           string
	Size             string
	Quality          string
	ForceSize        bool
	ReasoningEffort  string
	ReasoningSummary string
	MaxOutputBytes   int64
}

func NewClient(httpClient Doer) Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return Client{http: httpClient}
}

func (client Client) Generate(ctx context.Context, input Request) ([]byte, error) {
	if input.Endpoint == "" || input.APIKey == "" || input.Model == "" || strings.TrimSpace(input.Prompt) == "" {
		return nil, errors.New("image2 endpoint, API key, model, and prompt are required")
	}
	payload, err := json.Marshal(buildPayload(input))
	if err != nil {
		return nil, fmt.Errorf("encode image2 request: %w", err)
	}
	// Keep the reference-image path byte-for-byte aligned with the Python
	// client's json=payload request. Some OpenAI-compatible gateways reject
	// the previous streamed io.Pipe body before JSON parsing.
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, input.Endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("create image2 request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+input.APIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("User-Agent", "node")

	response, err := client.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("call image2: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return nil, fmt.Errorf("image2 request failed: status=%d body=%s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	if !strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		return nil, errors.New("image2 response is not an SSE stream")
	}
	image, err := parseSSEImage(response.Body, input.MaxOutputBytes)
	if err != nil {
		return nil, fmt.Errorf("parse image2 response: %w", err)
	}
	return image, nil
}

func buildTool(input Request) map[string]any {
	action := strings.TrimSpace(input.Action)
	if action == "" {
		action = map[bool]string{true: "edit", false: "generate"}[len(input.Images) > 0]
	}
	tool := map[string]any{
		"type":   "image_generation",
		"action": action,
	}
	if input.Size != "" && (input.ForceSize || input.Size != "1024x1024") {
		tool["size"] = input.Size
	}
	if input.Quality != "" {
		tool["quality"] = input.Quality
	}
	return tool
}

func buildPayload(input Request) map[string]any {
	tool := buildTool(input)
	var requestInput any = input.Prompt
	if len(input.Images) > 0 {
		content := []map[string]any{{"type": "input_text", "text": input.Prompt}}
		for _, image := range input.Images[:min(len(input.Images), 8)] {
			content = append(content, map[string]any{
				"type":      "input_image",
				"image_url": "data:image/png;base64," + base64.StdEncoding.EncodeToString(image),
			})
		}
		requestInput = []map[string]any{{"role": "user", "content": content}}
	}
	payload := map[string]any{
		"model":       input.Model,
		"input":       requestInput,
		"tools":       []map[string]any{tool},
		"tool_choice": map[string]any{"type": "image_generation"},
		"stream":      true,
	}
	if input.ReasoningEffort != "" || input.ReasoningSummary != "" {
		reasoning := map[string]any{}
		if input.ReasoningEffort != "" {
			reasoning["effort"] = input.ReasoningEffort
		}
		if input.ReasoningSummary != "" {
			reasoning["summary"] = input.ReasoningSummary
		}
		payload["reasoning"] = reasoning
	}
	return payload
}

func parseSSEImage(reader io.Reader, maxOutputBytes int64) ([]byte, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 32*1024), maxSSELineSize(maxOutputBytes))
	var imageBase64 string
	var completed bool
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var event map[string]any
		if json.Unmarshal([]byte(data), &event) != nil {
			continue
		}
		candidate, isCompleted := imageCandidate(event)
		if candidate != "" {
			imageBase64 = candidate
		}
		completed = completed || isCompleted
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if !completed || imageBase64 == "" {
		return nil, errors.New("image2 stream completed without image data")
	}
	imageBase64 = strings.TrimPrefix(imageBase64, "data:image/png;base64,")
	if maxOutputBytes > 0 && int64(base64.StdEncoding.DecodedLen(len(imageBase64))) > maxOutputBytes {
		return nil, errors.New("image2 result exceeds configured output limit")
	}
	image, err := base64.StdEncoding.DecodeString(imageBase64)
	if err != nil {
		return nil, errors.New("image2 returned invalid image Base64")
	}
	return image, nil
}

func maxSSELineSize(maxOutputBytes int64) int {
	if maxOutputBytes <= 0 {
		return maxSSELineBytes
	}
	// Base64 inflates output by about one third. Leave room for the small JSON
	// envelope while keeping a provider-controlled SSE line bounded.
	maxLine := maxOutputBytes + (maxOutputBytes+2)/3 + 8192
	if maxLine < 32*1024 {
		maxLine = 32 * 1024
	}
	if maxLine > int64(maxSSELineBytes) {
		maxLine = int64(maxSSELineBytes)
	}
	return int(maxLine)
}

func imageCandidate(event map[string]any) (string, bool) {
	completed := false
	if response, ok := event["response"].(map[string]any); ok {
		completed = isCompletedStatus(response["status"])
		if candidate := outputImageCandidate(response["output"]); candidate != "" {
			return candidate, completed
		}
	}
	completed = completed || isCompletedStatus(event["status"])
	if item, ok := event["item"].(map[string]any); ok {
		if candidate := imageItemCandidate(item); candidate != "" {
			return candidate, completed || event["type"] == "response.output_item.done"
		}
	}
	if candidate := outputImageCandidate(event["output"]); candidate != "" {
		return candidate, completed
	}
	for _, key := range []string{"partial_image_b64", "image_b64", "b64_json", "result"} {
		if candidate, ok := event[key].(string); ok && candidate != "" {
			return candidate, completed
		}
	}
	return "", completed
}

func outputImageCandidate(value any) string {
	items, ok := value.([]any)
	if !ok {
		return ""
	}
	for _, value := range items {
		if item, ok := value.(map[string]any); ok {
			if candidate := imageItemCandidate(item); candidate != "" {
				return candidate
			}
		}
	}
	return ""
}

func imageItemCandidate(item map[string]any) string {
	if item["type"] != "image_generation_call" {
		return ""
	}
	for _, key := range []string{"result", "b64_json"} {
		if candidate, ok := item[key].(string); ok && candidate != "" {
			return candidate
		}
	}
	return ""
}

func isCompletedStatus(value any) bool {
	status, _ := value.(string)
	return status == "completed" || status == "succeeded"
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
