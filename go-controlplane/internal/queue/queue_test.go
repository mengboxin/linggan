package queue

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestValidatePayloadAcceptsAssetReferences(t *testing.T) {
	err := ValidatePayload(map[string]any{
		"image_assets": []any{map[string]any{
			"key": "assets/users/u/queue-inputs/t/files/image.png", "size_bytes": 20 * 1024 * 1024,
		}},
		"image_bytes": "",
	})
	if err != nil {
		t.Fatalf("expected asset-reference payload to pass: %v", err)
	}
}

func TestValidatePayloadRejectsLegacyImageData(t *testing.T) {
	for _, payload := range []map[string]any{
		{"images_bytes_b64": []any{"large-base64"}},
		{"image_base64": "large-base64"},
	} {
		if err := ValidatePayload(payload); err == nil {
			t.Fatalf("expected binary payload to be rejected: %#v", payload)
		}
	}
}

func TestImage2ExecutionTargetUsesDedicatedStream(t *testing.T) {
	stream, err := streamForJob(Job{TaskType: "generate", ExecutionTarget: ExecutionTargetImage2})
	if err != nil {
		t.Fatal(err)
	}
	if stream != StreamImage2 {
		t.Fatalf("unexpected stream %q", stream)
	}
	if _, err := streamForJob(Job{TaskType: "poster", ExecutionTarget: ExecutionTargetImage2}); err == nil {
		t.Fatal("expected non-generate image2 target to fail")
	}
}

func TestImageHeavyExecutionTargetUsesDedicatedStream(t *testing.T) {
	stream, err := streamForJob(Job{TaskType: "touch-replace", ExecutionTarget: ExecutionTargetImageHeavy})
	if err != nil {
		t.Fatal(err)
	}
	if stream != StreamImageHeavy {
		t.Fatalf("unexpected stream %q", stream)
	}
	if _, err := streamForJob(Job{TaskType: "touch-remove", ExecutionTarget: ExecutionTargetImageHeavy}); err == nil {
		t.Fatal("expected remove to remain outside the Go heavy contract")
	}
}

func TestImage2StreamUsesTheSharedCapacityGateWithoutTrimming(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	errors := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			errors <- err
			return
		}
		defer conn.Close()
		args, err := readRequest(bufio.NewReader(conn))
		if err != nil {
			errors <- err
			return
		}
		if len(args) < 10 || args[0] != "EVAL" || args[2] != "5" {
			errors <- fmt.Errorf("image2 stream must use the capacity script, got %v", args)
			return
		}
		if strings.Join(args[3:8], "|") != strings.Join(capacityStreams, "|") || args[9] != StreamImage2 {
			errors <- fmt.Errorf("unexpected capacity streams or target: %v", args)
			return
		}
		for _, value := range args {
			if value == "MAXLEN" {
				errors <- fmt.Errorf("queue capacity gate must not use stream trimming: %v", args)
				return
			}
		}
		_, err = io.WriteString(conn, "*2\r\n:1\r\n$3\r\n1-0\r\n")
		errors <- err
	}()

	client, err := NewRedisClient("redis://" + listener.Addr().String() + "/0")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	jobs := NewStreamQueue(client, DefaultQueueCapacity)
	if _, err := jobs.Enqueue(context.Background(), Job{
		TaskID: "task-1", TaskType: "generate", UserID: "user-1", ExecutionTarget: ExecutionTargetImage2, Payload: map[string]any{},
	}); err != nil {
		t.Fatal(err)
	}
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
}

func TestClientAcknowledgesBeforeDeletingEntry(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	errors := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			errors <- err
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		if args, err := readRequest(reader); err != nil || strings.Join(args, "|") != strings.Join([]string{"XACK", StreamImage2, "image2-go", "1-0"}, "|") {
			errors <- fmt.Errorf("unexpected XACK request args=%v err=%v", args, err)
			return
		}
		if _, err := io.WriteString(conn, ":1\r\n"); err != nil {
			errors <- err
			return
		}
		if args, err := readRequest(reader); err != nil || strings.Join(args, "|") != strings.Join([]string{"XDEL", StreamImage2, "1-0"}, "|") {
			errors <- fmt.Errorf("unexpected XDEL request args=%v err=%v", args, err)
			return
		}
		_, err = io.WriteString(conn, ":1\r\n")
		errors <- err
	}()

	client, err := NewRedisClient("redis://" + listener.Addr().String() + "/0")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	acknowledged, err := client.Ack(context.Background(), StreamImage2, "image2-go", "1-0")
	if err != nil || !acknowledged {
		t.Fatalf("expected XACK to own entry, acknowledged=%v err=%v", acknowledged, err)
	}
	if err := client.Delete(context.Background(), StreamImage2, "1-0"); err != nil {
		t.Fatal(err)
	}
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
}

func TestClientUsesRESPForPingAndCapacityEnqueue(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	errors := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			errors <- err
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		if args, err := readRequest(reader); err != nil || strings.Join(args, " ") != "PING" {
			errors <- fmt.Errorf("unexpected PING request args=%v err=%v", args, err)
			return
		}
		if _, err := io.WriteString(conn, "+PONG\r\n"); err != nil {
			errors <- err
			return
		}
		args, err := readRequest(reader)
		if err != nil || len(args) < 11 || args[0] != "EVAL" || args[2] != "5" || args[9] != StreamNormal {
			errors <- fmt.Errorf("unexpected capacity enqueue request args=%v err=%v", args, err)
			return
		}
		if _, err = io.WriteString(conn, "*2\r\n:1\r\n$15\r\n1710000000000-0\r\n"); err != nil {
			errors <- err
			return
		}
		if args, err := readRequest(reader); err != nil || strings.Join(args, " ") != "GET task:task-1" {
			errors <- fmt.Errorf("unexpected GET request args=%v err=%v", args, err)
			return
		}
		_, err = io.WriteString(conn, "$2\r\n{}\r\n")
		errors <- err
	}()

	client, err := NewRedisClient("redis://" + listener.Addr().String() + "/0")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	queue := NewStreamQueue(client, DefaultQueueCapacity)
	messageID, err := queue.Enqueue(context.Background(), Job{
		TaskID: "task-1", TaskType: "generate", UserID: "user-1", Payload: map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if messageID != "1710000000000-0" {
		t.Fatalf("unexpected message ID %q", messageID)
	}
	value, found, err := client.Get(context.Background(), "task:task-1")
	if err != nil || !found || value != "{}" {
		t.Fatalf("unexpected GET result value=%q found=%v err=%v", value, found, err)
	}
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
}

func TestStreamQueueReturnsCapacityError(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	serverErrors := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErrors <- acceptErr
			return
		}
		defer conn.Close()
		args, readErr := readRequest(bufio.NewReader(conn))
		if readErr != nil || len(args) < 10 || args[0] != "EVAL" {
			serverErrors <- fmt.Errorf("unexpected capacity request args=%v err=%v", args, readErr)
			return
		}
		_, writeErr := io.WriteString(conn, "*2\r\n:0\r\n$2\r\n12\r\n")
		serverErrors <- writeErr
	}()

	client, err := NewRedisClient("redis://" + listener.Addr().String() + "/0")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	jobs := NewStreamQueue(client, 10)
	_, err = jobs.Enqueue(context.Background(), Job{TaskID: "task-full", TaskType: "generate", UserID: "user-1", Payload: map[string]any{}})
	var full *QueueCapacityError
	if !errors.As(err, &full) || full.Current != 12 || full.Limit != 10 {
		t.Fatalf("expected capacity error, got %#v", err)
	}
	if err := <-serverErrors; err != nil {
		t.Fatal(err)
	}
}

func TestClientAutoClaimReturnsReclaimedMessages(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	errors := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			errors <- err
			return
		}
		defer conn.Close()
		args, err := readRequest(bufio.NewReader(conn))
		if err != nil {
			errors <- err
			return
		}
		expected := []string{"XAUTOCLAIM", StreamImage2, "image2-go", "test", "300000", "0-0", "COUNT", "10"}
		if strings.Join(args, "|") != strings.Join(expected, "|") {
			errors <- fmt.Errorf("unexpected XAUTOCLAIM request args=%v", args)
			return
		}
		_, err = io.WriteString(conn, "*3\r\n$3\r\n0-0\r\n*1\r\n*2\r\n$3\r\n1-0\r\n*6\r\n$7\r\ntask_id\r\n$6\r\ntask-1\r\n$9\r\ntask_type\r\n$8\r\ngenerate\r\n$7\r\nuser_id\r\n$6\r\nuser-1\r\n*0\r\n")
		errors <- err
	}()

	client, err := NewRedisClient("redis://" + listener.Addr().String() + "/0")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	result, err := client.AutoClaim(context.Background(), StreamImage2, "image2-go", "test", 5*time.Minute, "0-0", 10)
	if err != nil {
		t.Fatal(err)
	}
	if result.NextStartID != "0-0" || len(result.Messages) != 1 {
		t.Fatalf("unexpected XAUTOCLAIM result %#v", result)
	}
	message := result.Messages[0]
	if !message.Reclaimed || message.ID != "1-0" || message.Stream != StreamImage2 || message.Fields["task_id"] != "task-1" {
		t.Fatalf("unexpected reclaimed message %#v", message)
	}
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
}

func TestParseAutoClaimResultAcceptsRedis62Reply(t *testing.T) {
	result, err := parseAutoClaimResult(StreamImage2, responseValue{Array: []responseValue{
		{String: "0-0"},
		{Array: []responseValue{}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if result.NextStartID != "0-0" || len(result.Messages) != 0 {
		t.Fatalf("unexpected Redis 6.2 XAUTOCLAIM result %#v", result)
	}
}

func TestParseAutoClaimResultReturnsRedis7DeletedIDs(t *testing.T) {
	result, err := parseAutoClaimResult(StreamImage2, responseValue{Array: []responseValue{
		{String: "0-0"},
		{Array: []responseValue{}},
		{Array: []responseValue{{String: "9-0"}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Messages) != 0 || len(result.DeletedIDs) != 1 || result.DeletedIDs[0] != "9-0" {
		t.Fatalf("unexpected Redis 7 deleted IDs %#v", result)
	}
}

func TestClientPoolCapsDialsAndReusesReleasedConnection(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer serverSide.Close()

	client, err := newRedisClient("redis://127.0.0.1:6379/0", 1)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var dials atomic.Int32
	client.dial = func(context.Context) (net.Conn, error) {
		dials.Add(1)
		return clientSide, nil
	}

	first, err := client.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	type acquireResult struct {
		conn net.Conn
		err  error
	}
	secondResult := make(chan acquireResult, 1)
	go func() {
		close(started)
		conn, acquireErr := client.acquire(context.Background())
		secondResult <- acquireResult{conn: conn, err: acquireErr}
	}()
	<-started

	select {
	case result := <-secondResult:
		t.Fatalf("second acquire returned before a connection was released: %#v", result)
	case <-time.After(25 * time.Millisecond):
	}
	if got := dials.Load(); got != 1 {
		t.Fatalf("expected exactly one dial while the pool is saturated, got %d", got)
	}

	client.release(first)
	select {
	case result := <-secondResult:
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.conn != first {
			t.Fatal("expected the waiting acquire to reuse the released connection")
		}
		client.release(result.conn)
	case <-time.After(time.Second):
		t.Fatal("waiting acquire did not resume after release")
	}
}

func TestClientPoolWakesAllWaitersWhenSeveralConnectionsReturn(t *testing.T) {
	firstClient, firstServer := net.Pipe()
	secondClient, secondServer := net.Pipe()
	defer firstServer.Close()
	defer secondServer.Close()

	client, err := newRedisClient("redis://127.0.0.1:6379/0", 2)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var dialIndex atomic.Int32
	client.dial = func(context.Context) (net.Conn, error) {
		switch dialIndex.Add(1) {
		case 1:
			return firstClient, nil
		case 2:
			return secondClient, nil
		default:
			return nil, errors.New("pool attempted an unexpected extra dial")
		}
	}

	first, err := client.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := client.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	type acquireResult struct {
		conn net.Conn
		err  error
	}
	results := make(chan acquireResult, 2)
	var started sync.WaitGroup
	started.Add(2)
	for range 2 {
		go func() {
			started.Done()
			conn, acquireErr := client.acquire(context.Background())
			results <- acquireResult{conn: conn, err: acquireErr}
		}()
	}
	started.Wait()
	select {
	case result := <-results:
		t.Fatalf("waiter returned before a connection was released: %#v", result)
	case <-time.After(25 * time.Millisecond):
	}

	client.release(first)
	client.release(second)
	acquired := make([]net.Conn, 0, 2)
	for range 2 {
		select {
		case result := <-results:
			if result.err != nil {
				t.Fatal(result.err)
			}
			acquired = append(acquired, result.conn)
		case <-time.After(time.Second):
			t.Fatal("not every waiting acquire resumed after connections were released")
		}
	}
	for _, conn := range acquired {
		client.release(conn)
	}
	if got := dialIndex.Load(); got != 2 {
		t.Fatalf("expected the two returned connections to satisfy both waiters, got %d dials", got)
	}
}

func TestClientPoolWaitHonorsContextDeadline(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer serverSide.Close()

	client, err := newRedisClient("redis://127.0.0.1:6379/0", 1)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var dials atomic.Int32
	client.dial = func(context.Context) (net.Conn, error) {
		dials.Add(1)
		return clientSide, nil
	}

	borrowed, err := client.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	_, err = client.acquire(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected a context deadline error, got %v", err)
	}
	if got := dials.Load(); got != 1 {
		t.Fatalf("expected pool wait to avoid an additional dial, got %d dials", got)
	}
	client.release(borrowed)
}

func TestClientCloseUnblocksWaitersAndClosesReturnedConnections(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer serverSide.Close()

	client, err := newRedisClient("redis://127.0.0.1:6379/0", 1)
	if err != nil {
		t.Fatal(err)
	}
	client.dial = func(context.Context) (net.Conn, error) {
		return clientSide, nil
	}

	borrowed, err := client.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	waiter := make(chan error, 1)
	go func() {
		_, acquireErr := client.acquire(context.Background())
		waiter <- acquireErr
	}()

	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-waiter:
		if !errors.Is(err, ErrRedisClientClosed) {
			t.Fatalf("expected a closed-client error, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not unblock a waiting acquire")
	}
	client.release(borrowed)

	_ = serverSide.SetReadDeadline(time.Now().Add(time.Second))
	_, err = serverSide.Read(make([]byte, 1))
	if !errors.Is(err, io.EOF) {
		t.Fatalf("expected returned connection to be closed after Close, got %v", err)
	}
	client.mu.Lock()
	openConnections := client.openConnections
	client.mu.Unlock()
	if openConnections != 0 {
		t.Fatalf("expected no open pool slots after Close and release, got %d", openConnections)
	}
}

func TestClientCloseDuringDialClosesTheNewConnectionAndReleasesItsSlot(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer serverSide.Close()

	client, err := newRedisClient("redis://127.0.0.1:6379/0", 1)
	if err != nil {
		t.Fatal(err)
	}
	dialStarted := make(chan struct{})
	allowDial := make(chan struct{})
	client.dial = func(context.Context) (net.Conn, error) {
		close(dialStarted)
		<-allowDial
		return clientSide, nil
	}
	result := make(chan error, 1)
	go func() {
		_, acquireErr := client.acquire(context.Background())
		result <- acquireErr
	}()
	<-dialStarted

	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	close(allowDial)
	select {
	case err := <-result:
		if !errors.Is(err, ErrRedisClientClosed) {
			t.Fatalf("expected a closed-client error after a racing dial, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("racing dial did not finish after Close")
	}

	_ = serverSide.SetReadDeadline(time.Now().Add(time.Second))
	_, err = serverSide.Read(make([]byte, 1))
	if !errors.Is(err, io.EOF) {
		t.Fatalf("expected the connection from a racing dial to be closed, got %v", err)
	}
	client.mu.Lock()
	openConnections := client.openConnections
	client.mu.Unlock()
	if openConnections != 0 {
		t.Fatalf("expected racing dial slot to be released, got %d", openConnections)
	}
}

func readRequest(reader *bufio.Reader) ([]string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(line, "*") {
		return nil, fmt.Errorf("expected array request")
	}
	count, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "*")))
	if err != nil {
		return nil, err
	}
	args := make([]string, 0, count)
	for range count {
		lengthLine, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		length, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(lengthLine, "$")))
		if err != nil {
			return nil, err
		}
		body := make([]byte, length+2)
		if _, err := io.ReadFull(reader, body); err != nil {
			return nil, err
		}
		args = append(args, string(body[:length]))
	}
	return args, nil
}
