// Package queue implements the small Redis Streams contract shared with the
// existing Python workers. It deliberately carries metadata and asset refs,
// never raw image data.
package queue

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	StreamHigh                      = "queue:high"
	StreamNormal                    = "queue:normal"
	StreamLow                       = "queue:low"
	StreamImage2                    = "queue:image2"
	StreamImageHeavy                = "queue:image-heavy"
	ExecutionTargetImage2           = "go-image2"
	ExecutionTargetImageHeavy       = "go-image-heavy"
	DefaultQueueCapacity      int64 = 10000
	defaultRedisPoolMaxConns        = 64
)

var priorityStreams = map[string]string{
	"high": StreamHigh, "normal": StreamNormal, "low": StreamLow,
}

var capacityStreams = []string{StreamHigh, StreamNormal, StreamLow, StreamImage2, StreamImageHeavy}

const enqueueWithCapacityScript = `
local total = 0
for _, stream in ipairs(KEYS) do
  total = total + redis.call('XLEN', stream)
end
if total >= tonumber(ARGV[1]) then
  return {0, tostring(total)}
end
local messageID = redis.call('XADD', ARGV[2], '*', unpack(ARGV, 3))
return {1, messageID}
`

type QueueCapacityError struct {
	Current int64
	Limit   int64
}

func (err *QueueCapacityError) Error() string {
	return fmt.Sprintf("global task queue has %d active entries (limit=%d)", err.Current, err.Limit)
}

type Job struct {
	TaskID          string
	TaskType        string
	UserID          string
	Priority        string
	BillingMode     string
	ExecutionTarget string
	Payload         map[string]any
}

type Client struct {
	address         string
	username        string
	password        string
	database        int
	idle            chan net.Conn
	available       chan struct{}
	closedCh        chan struct{}
	maxConnections  int
	openConnections int
	closed          bool
	mu              sync.Mutex
	dial            func(context.Context) (net.Conn, error)
}

// ErrRedisClientClosed is returned when a caller tries to use a closed Redis
// client or when Close races with a pending connection acquisition.
var ErrRedisClientClosed = errors.New("redis client is closed")

type StreamMessage struct {
	ID        string
	Stream    string
	Fields    map[string]string
	Reclaimed bool
}

// AutoClaimResult contains a page of stale pending messages claimed by this
// consumer. NextStartID must be supplied to the next XAUTOCLAIM call so Redis
// can continue scanning the pending entries list efficiently.
type AutoClaimResult struct {
	NextStartID string
	Messages    []StreamMessage
	// DeletedIDs is populated by Redis 7 when it finds a PEL entry whose
	// stream record was trimmed or deleted. There are no fields left to process
	// or acknowledge, so callers must surface it for reconciliation.
	DeletedIDs []string
}

type responseValue struct {
	String string
	Array  []responseValue
	Nil    bool
}

func NewRedisClient(rawURL string) (*Client, error) {
	return newRedisClient(rawURL, defaultRedisPoolMaxConns)
}

func newRedisClient(rawURL string, maxConnections int) (*Client, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme != "redis" {
		return nil, fmt.Errorf("only redis:// URLs are supported")
	}
	address := parsed.Host
	if !strings.Contains(address, ":") {
		address += ":6379"
	}
	database := 0
	if path := strings.Trim(parsed.Path, "/"); path != "" {
		database, err = strconv.Atoi(path)
		if err != nil || database < 0 {
			return nil, fmt.Errorf("invalid Redis database")
		}
	}
	password, _ := parsed.User.Password()
	if maxConnections <= 0 {
		maxConnections = defaultRedisPoolMaxConns
	}
	client := &Client{
		address:        address,
		username:       parsed.User.Username(),
		password:       password,
		database:       database,
		idle:           make(chan net.Conn, maxConnections),
		available:      make(chan struct{}),
		closedCh:       make(chan struct{}),
		maxConnections: maxConnections,
	}
	client.dial = func(ctx context.Context) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", client.address)
	}
	return client, nil
}

func (client *Client) Close() error {
	client.mu.Lock()
	if client.closed {
		client.mu.Unlock()
		return nil
	}
	client.closed = true
	close(client.closedCh)
	idleConnections := make([]net.Conn, 0, len(client.idle))
	for {
		select {
		case conn := <-client.idle:
			idleConnections = append(idleConnections, conn)
			client.openConnections--
		default:
			client.mu.Unlock()
			for _, conn := range idleConnections {
				_ = conn.Close()
			}
			return nil
		}
	}
}

func (client *Client) Ping(ctx context.Context) error {
	response, err := client.command(ctx, "PING")
	if err != nil {
		return err
	}
	if response != "PONG" {
		return fmt.Errorf("unexpected PING response %q", response)
	}
	return nil
}

// Get returns a Redis string value. An absent key is represented by found=false.
func (client *Client) Get(ctx context.Context, key string) (value string, found bool, err error) {
	value, err = client.command(ctx, "GET", key)
	if err != nil {
		return "", false, err
	}
	return value, value != "", nil
}

func (client *Client) XAddWithCapacity(ctx context.Context, stream string, capacity int64, values map[string]string) (string, error) {
	if capacity <= 0 {
		capacity = DefaultQueueCapacity
	}
	args := []string{"EVAL", enqueueWithCapacityScript, strconv.Itoa(len(capacityStreams))}
	args = append(args, capacityStreams...)
	args = append(args, strconv.FormatInt(capacity, 10), stream)
	for _, key := range []string{"task_id", "task_type", "user_id", "payload", "enqueue_at", "retries", "billing_mode"} {
		if key == "billing_mode" && values[key] == "" {
			continue
		}
		args = append(args, key, values[key])
	}
	value, err := client.commandValue(ctx, args...)
	if err != nil {
		return "", err
	}
	if len(value.Array) != 2 {
		return "", errors.New("invalid queue capacity response")
	}
	accepted, err := strconv.ParseInt(value.Array[0].String, 10, 64)
	if err != nil {
		return "", fmt.Errorf("parse queue capacity response: %w", err)
	}
	if accepted == 0 {
		current, parseErr := strconv.ParseInt(value.Array[1].String, 10, 64)
		if parseErr != nil {
			current = capacity
		}
		return "", &QueueCapacityError{Current: current, Limit: capacity}
	}
	if accepted != 1 || strings.TrimSpace(value.Array[1].String) == "" {
		return "", errors.New("invalid queue capacity response")
	}
	return value.Array[1].String, nil
}

func (client *Client) EnsureGroup(ctx context.Context, stream, group string) error {
	_, err := client.command(ctx, "XGROUP", "CREATE", stream, group, "0", "MKSTREAM")
	if err != nil && strings.Contains(err.Error(), "BUSYGROUP") {
		return nil
	}
	return err
}

func (client *Client) ReadGroup(ctx context.Context, stream, group, consumer string, block time.Duration) ([]StreamMessage, error) {
	blockMilliseconds := strconv.FormatInt(block.Milliseconds(), 10)
	value, err := client.commandValue(
		ctx, "XREADGROUP", "GROUP", group, consumer, "COUNT", "1", "BLOCK", blockMilliseconds, "STREAMS", stream, ">",
	)
	if err != nil || value.Nil {
		return nil, err
	}
	return parseStreamMessages(value)
}

// AutoClaim transfers pending messages that have been idle for at least
// minIdle to consumer. Redis 6.2+ returns an opaque cursor; callers should
// preserve it between calls and start at 0-0 for a fresh PEL scan.
func (client *Client) AutoClaim(
	ctx context.Context,
	stream, group, consumer string,
	minIdle time.Duration,
	startID string,
	count int,
) (AutoClaimResult, error) {
	if minIdle < 0 {
		return AutoClaimResult{}, errors.New("XAUTOCLAIM minimum idle time cannot be negative")
	}
	startID = strings.TrimSpace(startID)
	if startID == "" {
		startID = "0-0"
	}
	args := []string{
		"XAUTOCLAIM", stream, group, consumer,
		strconv.FormatInt(minIdle.Milliseconds(), 10), startID,
	}
	if count > 0 {
		args = append(args, "COUNT", strconv.Itoa(count))
	}
	value, err := client.commandValue(ctx, args...)
	if err != nil {
		return AutoClaimResult{}, err
	}
	return parseAutoClaimResult(stream, value)
}

func (client *Client) Ack(ctx context.Context, stream, group, messageID string) (bool, error) {
	value, err := client.command(ctx, "XACK", stream, group, messageID)
	if err != nil {
		return false, err
	}
	count, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return false, fmt.Errorf("parse XACK result: %w", err)
	}
	return count > 0, nil
}

// Delete removes an already-acknowledged stream record. It is deliberately
// separate from Ack because Redis 6.2 does not provide an atomic XACKDEL.
func (client *Client) Delete(ctx context.Context, stream, messageID string) error {
	_, err := client.command(ctx, "XDEL", stream, messageID)
	return err
}

func (client *Client) command(ctx context.Context, args ...string) (string, error) {
	value, err := client.commandValue(ctx, args...)
	if err != nil {
		return "", err
	}
	if value.Nil {
		return "", nil
	}
	if value.Array != nil {
		return "", fmt.Errorf("unexpected Redis array response")
	}
	return value.String, nil
}

func (client *Client) commandValue(ctx context.Context, args ...string) (responseValue, error) {
	conn, err := client.acquire(ctx)
	if err != nil {
		return responseValue{}, err
	}
	usable := false
	defer func() {
		if usable {
			client.release(conn)
		} else {
			client.discard(conn)
		}
	}()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	}
	writer := bufio.NewWriter(conn)
	if err := writeRESP(writer, args...); err != nil {
		return responseValue{}, err
	}
	if err := writer.Flush(); err != nil {
		return responseValue{}, err
	}
	response, err := readRESPValue(bufio.NewReader(conn))
	if err != nil {
		return responseValue{}, err
	}
	usable = true
	return response, nil
}

func (client *Client) acquire(ctx context.Context) (net.Conn, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		client.mu.Lock()
		if client.closed {
			client.mu.Unlock()
			return nil, ErrRedisClientClosed
		}
		select {
		case conn := <-client.idle:
			client.mu.Unlock()
			return conn, nil
		default:
		}
		if client.openConnections < client.maxConnections {
			// Reserve a slot before dialing. This includes in-flight dials in
			// the cap, so a burst cannot create an unbounded connection storm.
			client.openConnections++
			client.mu.Unlock()
			return client.dialAndInitialize(ctx)
		}
		available := client.available
		closedCh := client.closedCh
		client.mu.Unlock()

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-closedCh:
			return nil, ErrRedisClientClosed
		case <-available:
			// A released or discarded connection changed availability. Recheck
			// the pool state under the mutex before using it.
		}
	}
}

func (client *Client) dialAndInitialize(ctx context.Context) (net.Conn, error) {
	conn, err := client.dial(ctx)
	if err != nil {
		client.releaseConnectionSlot()
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		client.discard(conn)
		return nil, err
	}
	if client.password == "" && client.database == 0 {
		return client.keepDialedConnection(conn)
	}
	deadline := time.Now().Add(10 * time.Second)
	if fromContext, ok := ctx.Deadline(); ok {
		deadline = fromContext
	}
	_ = conn.SetDeadline(deadline)
	writer := bufio.NewWriter(conn)
	reader := bufio.NewReader(conn)
	if client.password != "" {
		auth := []string{"AUTH"}
		if client.username != "" {
			auth = append(auth, client.username)
		}
		auth = append(auth, client.password)
		if err := writeRESP(writer, auth...); err != nil {
			client.discard(conn)
			return nil, err
		}
		if err := writer.Flush(); err != nil {
			client.discard(conn)
			return nil, err
		}
		if _, err := readRESPValue(reader); err != nil {
			client.discard(conn)
			return nil, err
		}
	}
	if client.database != 0 {
		if err := writeRESP(writer, "SELECT", strconv.Itoa(client.database)); err != nil {
			client.discard(conn)
			return nil, err
		}
		if err := writer.Flush(); err != nil {
			client.discard(conn)
			return nil, err
		}
		if _, err := readRESPValue(reader); err != nil {
			client.discard(conn)
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		client.discard(conn)
		return nil, err
	}
	return client.keepDialedConnection(conn)
}

func (client *Client) release(conn net.Conn) {
	_ = conn.SetDeadline(time.Time{})
	client.mu.Lock()
	if client.closed {
		client.openConnections--
		client.mu.Unlock()
		_ = conn.Close()
		return
	}
	select {
	case client.idle <- conn:
		client.signalAvailableLocked()
		client.mu.Unlock()
	default:
		client.openConnections--
		client.signalAvailableLocked()
		client.mu.Unlock()
		_ = conn.Close()
	}
}

func (client *Client) keepDialedConnection(conn net.Conn) (net.Conn, error) {
	client.mu.Lock()
	if !client.closed {
		client.mu.Unlock()
		return conn, nil
	}
	client.openConnections--
	client.mu.Unlock()
	_ = conn.Close()
	return nil, ErrRedisClientClosed
}

func (client *Client) discard(conn net.Conn) {
	if conn != nil {
		_ = conn.Close()
	}
	client.releaseConnectionSlot()
}

func (client *Client) releaseConnectionSlot() {
	client.mu.Lock()
	client.openConnections--
	if !client.closed {
		client.signalAvailableLocked()
	}
	client.mu.Unlock()
}

func (client *Client) signalAvailableLocked() {
	// Closing and replacing the channel broadcasts to all waiters. A buffered
	// one-shot signal can strand waiters when several connections are returned
	// at once, even though idle connections are already available.
	close(client.available)
	client.available = make(chan struct{})
}

func writeRESP(writer *bufio.Writer, args ...string) error {
	if _, err := fmt.Fprintf(writer, "*%d\r\n", len(args)); err != nil {
		return err
	}
	for _, arg := range args {
		if _, err := fmt.Fprintf(writer, "$%d\r\n%s\r\n", len(arg), arg); err != nil {
			return err
		}
	}
	return nil
}

func readRESPValue(reader *bufio.Reader) (responseValue, error) {
	prefix, err := reader.ReadByte()
	if err != nil {
		return responseValue{}, err
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		return responseValue{}, err
	}
	line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
	switch prefix {
	case '+', ':':
		return responseValue{String: line}, nil
	case '-':
		return responseValue{}, errors.New(line)
	case '$':
		length, err := strconv.Atoi(line)
		if err != nil || length < -1 {
			return responseValue{}, fmt.Errorf("invalid Redis bulk reply")
		}
		if length == -1 {
			return responseValue{Nil: true}, nil
		}
		body := make([]byte, length+2)
		if _, err := io.ReadFull(reader, body); err != nil {
			return responseValue{}, err
		}
		return responseValue{String: string(body[:length])}, nil
	case '*':
		length, err := strconv.Atoi(line)
		if err != nil || length < -1 {
			return responseValue{}, fmt.Errorf("invalid Redis array reply")
		}
		if length == -1 {
			return responseValue{Nil: true}, nil
		}
		items := make([]responseValue, 0, length)
		for range length {
			item, err := readRESPValue(reader)
			if err != nil {
				return responseValue{}, err
			}
			items = append(items, item)
		}
		return responseValue{Array: items}, nil
	default:
		return responseValue{}, fmt.Errorf("unsupported Redis response type %q", prefix)
	}
}

func parseStreamMessages(value responseValue) ([]StreamMessage, error) {
	messages := make([]StreamMessage, 0)
	for _, streamValue := range value.Array {
		if len(streamValue.Array) != 2 {
			return nil, errors.New("invalid Redis stream response")
		}
		stream := streamValue.Array[0].String
		for _, entry := range streamValue.Array[1].Array {
			message, err := parseStreamEntry(stream, entry, false)
			if err != nil {
				return nil, err
			}
			messages = append(messages, message)
		}
	}
	return messages, nil
}

func parseAutoClaimResult(stream string, value responseValue) (AutoClaimResult, error) {
	if value.Nil {
		return AutoClaimResult{NextStartID: "0-0"}, nil
	}
	// Redis 6.2 replies with [next-id, entries]. Redis 7 adds a third array of
	// deleted IDs for PEL records whose stream entries no longer exist.
	if len(value.Array) != 2 && len(value.Array) != 3 {
		return AutoClaimResult{}, errors.New("invalid Redis XAUTOCLAIM response")
	}
	nextStartID := strings.TrimSpace(value.Array[0].String)
	if nextStartID == "" {
		return AutoClaimResult{}, errors.New("Redis XAUTOCLAIM response has no next start ID")
	}
	entries := value.Array[1].Array
	messages := make([]StreamMessage, 0, len(entries))
	for _, entry := range entries {
		message, err := parseStreamEntry(stream, entry, true)
		if err != nil {
			return AutoClaimResult{}, err
		}
		messages = append(messages, message)
	}
	deletedIDs := make([]string, 0)
	if len(value.Array) == 3 {
		for _, deleted := range value.Array[2].Array {
			messageID := strings.TrimSpace(deleted.String)
			if messageID == "" {
				return AutoClaimResult{}, errors.New("invalid deleted ID in Redis XAUTOCLAIM response")
			}
			deletedIDs = append(deletedIDs, messageID)
		}
	}
	return AutoClaimResult{NextStartID: nextStartID, Messages: messages, DeletedIDs: deletedIDs}, nil
}

func parseStreamEntry(stream string, entry responseValue, reclaimed bool) (StreamMessage, error) {
	if len(entry.Array) != 2 || len(entry.Array[1].Array)%2 != 0 {
		return StreamMessage{}, errors.New("invalid Redis stream entry")
	}
	messageID := strings.TrimSpace(entry.Array[0].String)
	if messageID == "" {
		return StreamMessage{}, errors.New("Redis stream entry has no ID")
	}
	fields := make(map[string]string, len(entry.Array[1].Array)/2)
	for index := 0; index < len(entry.Array[1].Array); index += 2 {
		fields[entry.Array[1].Array[index].String] = entry.Array[1].Array[index+1].String
	}
	return StreamMessage{ID: messageID, Stream: stream, Fields: fields, Reclaimed: reclaimed}, nil
}

type StreamQueue struct {
	client   *Client
	capacity int64
}

func NewStreamQueue(client *Client, capacity int64) StreamQueue {
	if capacity <= 0 {
		capacity = DefaultQueueCapacity
	}
	return StreamQueue{client: client, capacity: capacity}
}

func (queue StreamQueue) Enqueue(ctx context.Context, job Job) (string, error) {
	payload, err := json.Marshal(job.Payload)
	if err != nil {
		return "", fmt.Errorf("marshal payload: %w", err)
	}
	stream, err := streamForJob(job)
	if err != nil {
		return "", err
	}
	return queue.client.XAddWithCapacity(ctx, stream, queue.capacity, map[string]string{
		"task_id": job.TaskID, "task_type": job.TaskType, "user_id": job.UserID,
		"payload": string(payload), "enqueue_at": fmt.Sprintf("%.6f", float64(time.Now().UnixNano())/1e9),
		"retries": "0", "billing_mode": job.BillingMode,
	})
}

func streamForJob(job Job) (string, error) {
	target := strings.TrimSpace(job.ExecutionTarget)
	if target == ExecutionTargetImage2 {
		if job.TaskType != "generate" {
			return "", errors.New("go-image2 execution target only accepts generate tasks")
		}
		return StreamImage2, nil
	}
	if target == ExecutionTargetImageHeavy {
		if job.TaskType != "touch-replace" && job.TaskType != "touch-recolor" {
			return "", errors.New("go-image-heavy execution target only accepts touch replace/recolor tasks")
		}
		return StreamImageHeavy, nil
	}
	if target != "" {
		return "", fmt.Errorf("unknown execution target %q", target)
	}
	stream := priorityStreams[strings.ToLower(strings.TrimSpace(job.Priority))]
	if stream == "" {
		stream = StreamNormal
	}
	return stream, nil
}

// ValidatePayload keeps raw image values out of Redis while allowing metadata
// such as size_bytes on image_asset(s).
func ValidatePayload(payload map[string]any) error {
	var walk func(map[string]any) error
	walk = func(current map[string]any) error {
		for key, value := range current {
			lower := strings.ToLower(key)
			if isBinaryQueueField(lower) && hasValue(value) {
				return fmt.Errorf("binary queue field %q is forbidden; use an asset reference", key)
			}
			switch typed := value.(type) {
			case map[string]any:
				if err := walk(typed); err != nil {
					return err
				}
			case []any:
				for _, item := range typed {
					if nested, ok := item.(map[string]any); ok {
						if err := walk(nested); err != nil {
							return err
						}
					}
				}
			}
		}
		return nil
	}
	if payload == nil {
		return errors.New("payload is required")
	}
	return walk(payload)
}

func isBinaryQueueField(field string) bool {
	return field == "image_bytes" || field == "mask_bytes" || field == "images_bytes_b64" ||
		field == "image_base64" || field == "image_b64" || field == "mask_base64" || field == "mask_b64" ||
		strings.HasSuffix(field, "_image_bytes") || strings.HasSuffix(field, "_mask_bytes") ||
		strings.HasSuffix(field, "_image_base64") || strings.HasSuffix(field, "_image_b64")
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
