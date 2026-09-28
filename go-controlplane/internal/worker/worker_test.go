package worker

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"pixelscribe/go-controlplane/internal/queue"
)

type fakeClient struct {
	mu               sync.Mutex
	messages         []queue.StreamMessage
	autoClaimResults []queue.AutoClaimResult
	autoClaimCalls   []autoClaimCall
	acked            []string
	deleted          []string
	ackReturnsZero   bool
	ackCanceled      []bool
}

type autoClaimCall struct {
	stream   string
	group    string
	consumer string
	minIdle  time.Duration
	startID  string
	count    int
}

func (client *fakeClient) EnsureGroup(context.Context, string, string) error { return nil }
func (client *fakeClient) ReadGroup(context.Context, string, string, string, time.Duration) ([]queue.StreamMessage, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.messages) == 0 {
		return nil, nil
	}
	message := client.messages[0]
	client.messages = client.messages[1:]
	return []queue.StreamMessage{message}, nil
}
func (client *fakeClient) AutoClaim(_ context.Context, stream, group, consumer string, minIdle time.Duration, startID string, count int) (queue.AutoClaimResult, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.autoClaimCalls = append(client.autoClaimCalls, autoClaimCall{
		stream: stream, group: group, consumer: consumer, minIdle: minIdle, startID: startID, count: count,
	})
	if len(client.autoClaimResults) == 0 {
		return queue.AutoClaimResult{NextStartID: "0-0"}, nil
	}
	result := client.autoClaimResults[0]
	client.autoClaimResults = client.autoClaimResults[1:]
	return result, nil
}
func (client *fakeClient) Ack(ctx context.Context, _ string, _ string, messageID string) (bool, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.acked = append(client.acked, messageID)
	client.ackCanceled = append(client.ackCanceled, ctx.Err() != nil)
	return !client.ackReturnsZero, nil
}
func (client *fakeClient) Delete(_ context.Context, _ string, messageID string) error {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.deleted = append(client.deleted, messageID)
	return nil
}

type fakeProcessor struct{ processed chan queue.StreamMessage }

func (processor fakeProcessor) Process(_ context.Context, message queue.StreamMessage) error {
	processor.processed <- message
	return nil
}

type failingProcessor struct{ processed chan queue.StreamMessage }

func (processor failingProcessor) Process(_ context.Context, message queue.StreamMessage) error {
	processor.processed <- message
	return errors.New("terminal callback unavailable")
}

func TestWorkerAcknowledgesOnlyAfterProcessing(t *testing.T) {
	client := &fakeClient{messages: []queue.StreamMessage{{ID: "1-0", Stream: "queue:image2"}}}
	processed := make(chan queue.StreamMessage, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	worker := New(client, fakeProcessor{processed: processed}, "queue:image2", "go-image2", "test")
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()
	select {
	case message := <-processed:
		if message.ID != "1-0" || message.Reclaimed {
			t.Fatalf("unexpected processed message %#v", message)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not process message")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not stop")
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.acked) != 1 || client.acked[0] != "1-0" {
		t.Fatalf("unexpected ACKs %#v", client.acked)
	}
	if len(client.deleted) != 1 || client.deleted[0] != "1-0" {
		t.Fatalf("expected completed image2 entry to be deleted, got %#v", client.deleted)
	}
}

func TestWorkerDoesNotDeleteWhenAckDoesNotOwnPendingEntry(t *testing.T) {
	client := &fakeClient{ackReturnsZero: true}
	processed := make(chan queue.StreamMessage, 1)
	worker := New(client, fakeProcessor{processed: processed}, queue.StreamImage2, "image2-go", "test")
	worker.processAndAck(context.Background(), queue.StreamMessage{ID: "1-0", Stream: queue.StreamImage2})
	<-processed

	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.acked) != 1 || len(client.deleted) != 0 {
		t.Fatalf("must not delete a message after a zero XACK result: acked=%#v deleted=%#v", client.acked, client.deleted)
	}
}

type deadlineProcessor struct{ finished chan error }

func (processor deadlineProcessor) Process(ctx context.Context, _ queue.StreamMessage) error {
	<-ctx.Done()
	processor.finished <- ctx.Err()
	return ctx.Err()
}

func TestWorkerBoundsProcessingBeforeReclaimTimeout(t *testing.T) {
	if defaultProcessTimeout >= defaultReclaimMinIdle {
		t.Fatalf("process timeout %s must remain below reclaim idle time %s", defaultProcessTimeout, defaultReclaimMinIdle)
	}
	client := &fakeClient{}
	finished := make(chan error, 1)
	worker := NewWithConfig(client, deadlineProcessor{finished: finished}, queue.StreamImage2, "image2-go", "test", Config{
		ProcessTimeout: 10 * time.Millisecond,
	})
	worker.processAndAck(context.Background(), queue.StreamMessage{ID: "1-0", Stream: queue.StreamImage2})
	select {
	case err := <-finished:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("unexpected process context error %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not cancel the bounded process context")
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.acked) != 0 {
		t.Fatalf("timed out work was ACKed %#v", client.acked)
	}
}

type drainingProcessor struct {
	started  chan struct{}
	release  chan struct{}
	canceled chan bool
}

func (processor drainingProcessor) Process(ctx context.Context, _ queue.StreamMessage) error {
	processor.started <- struct{}{}
	<-processor.release
	select {
	case <-ctx.Done():
		processor.canceled <- true
		return ctx.Err()
	default:
		processor.canceled <- false
		return nil
	}
}

func TestWorkerDrainsActiveDeliveryAfterParentCancellation(t *testing.T) {
	client := &fakeClient{}
	processor := drainingProcessor{
		started: make(chan struct{}, 1), release: make(chan struct{}), canceled: make(chan bool, 1),
	}
	worker := New(client, processor, queue.StreamImage2, "image2-go", "test")
	parent, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		worker.processAndAck(parent, queue.StreamMessage{ID: "1-0", Stream: queue.StreamImage2})
		close(done)
	}()
	<-processor.started
	cancel()
	close(processor.release)

	select {
	case canceled := <-processor.canceled:
		if canceled {
			t.Fatal("shutdown cancellation interrupted the active delivery")
		}
	case <-time.After(time.Second):
		t.Fatal("active delivery did not finish")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not finish the active delivery")
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.acked) != 1 || len(client.deleted) != 1 || len(client.ackCanceled) != 1 || client.ackCanceled[0] {
		t.Fatalf("drained delivery was not finalized with a live context: acked=%#v deleted=%#v canceled=%#v", client.acked, client.deleted, client.ackCanceled)
	}
}

func TestWorkerProcessesReclaimedMessageAtStartup(t *testing.T) {
	client := &fakeClient{autoClaimResults: []queue.AutoClaimResult{{
		NextStartID: "0-0",
		Messages: []queue.StreamMessage{{
			ID: "pending-1", Stream: queue.StreamImage2, Reclaimed: true,
		}},
	}}}
	processed := make(chan queue.StreamMessage, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	worker := NewWithConfig(client, fakeProcessor{processed: processed}, queue.StreamImage2, "image2-go", "test", Config{
		ReadBlock: 10 * time.Millisecond, ReclaimInterval: time.Hour,
	})
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()

	select {
	case message := <-processed:
		if message.ID != "pending-1" || !message.Reclaimed {
			t.Fatalf("unexpected reclaimed message %#v", message)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not process the startup reclaim")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not stop")
	}

	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.autoClaimCalls) != 1 {
		t.Fatalf("expected one startup XAUTOCLAIM call, got %#v", client.autoClaimCalls)
	}
	call := client.autoClaimCalls[0]
	if call.stream != queue.StreamImage2 || call.group != "image2-go" || call.startID != "0-0" || call.minIdle != defaultReclaimMinIdle || call.count != defaultReclaimCount {
		t.Fatalf("unexpected startup XAUTOCLAIM call %#v", call)
	}
	if len(client.acked) != 1 || client.acked[0] != "pending-1" {
		t.Fatalf("unexpected reclaimed ACKs %#v", client.acked)
	}
}

func TestWorkerContinuesReclaimScanAfterEmptyPage(t *testing.T) {
	client := &fakeClient{autoClaimResults: []queue.AutoClaimResult{
		{NextStartID: "42-0"},
		{NextStartID: "0-0", Messages: []queue.StreamMessage{{
			ID: "pending-after-empty-page", Stream: queue.StreamImage2,
		}}},
	}}
	processed := make(chan queue.StreamMessage, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	worker := NewWithConfig(client, fakeProcessor{processed: processed}, queue.StreamImage2, "image2-go", "test", Config{
		ReadBlock: 10 * time.Millisecond, ReclaimInterval: time.Hour, ReclaimMaxPages: 2,
	})
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()

	select {
	case message := <-processed:
		if message.ID != "pending-after-empty-page" || !message.Reclaimed {
			t.Fatalf("unexpected reclaimed message %#v", message)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not continue the reclaimed PEL scan")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not stop")
	}

	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.autoClaimCalls) != 2 || client.autoClaimCalls[0].startID != "0-0" || client.autoClaimCalls[1].startID != "42-0" {
		t.Fatalf("worker did not preserve the XAUTOCLAIM cursor %#v", client.autoClaimCalls)
	}
	if len(client.acked) != 1 || client.acked[0] != "pending-after-empty-page" {
		t.Fatalf("unexpected reclaimed ACKs %#v", client.acked)
	}
}

func TestWorkerLeavesReclaimedMessagePendingWhenProcessingFails(t *testing.T) {
	client := &fakeClient{autoClaimResults: []queue.AutoClaimResult{{
		NextStartID: "0-0",
		Messages:    []queue.StreamMessage{{ID: "pending-fail", Stream: queue.StreamImage2}},
	}}}
	processed := make(chan queue.StreamMessage, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	worker := NewWithConfig(client, failingProcessor{processed: processed}, queue.StreamImage2, "image2-go", "test", Config{
		ReadBlock: 10 * time.Millisecond, ReclaimInterval: time.Hour,
	})
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()

	select {
	case message := <-processed:
		if message.ID != "pending-fail" || !message.Reclaimed {
			t.Fatalf("unexpected failed reclaimed message %#v", message)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not attempt the reclaimed message")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not stop")
	}

	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.acked) != 0 {
		t.Fatalf("failed reclaimed message was ACKed %#v", client.acked)
	}
}

func TestWorkerPeriodicallyProcessesReclaimedMessages(t *testing.T) {
	client := &fakeClient{autoClaimResults: []queue.AutoClaimResult{
		{NextStartID: "42-0"},
		{NextStartID: "0-0", Messages: []queue.StreamMessage{{
			ID: "pending-2", Stream: queue.StreamImage2, Reclaimed: true,
		}}},
	}}
	processed := make(chan queue.StreamMessage, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	worker := NewWithConfig(client, fakeProcessor{processed: processed}, queue.StreamImage2, "image2-go", "test", Config{
		ReadBlock: 1 * time.Millisecond, ReclaimMinIdle: 10 * time.Millisecond,
		ReclaimInterval: 5 * time.Millisecond, ReclaimCount: 2, ReclaimMaxPages: 1,
	})
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()

	select {
	case message := <-processed:
		if message.ID != "pending-2" || !message.Reclaimed {
			t.Fatalf("unexpected periodic reclaimed message %#v", message)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not process the periodic reclaim")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not stop")
	}

	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.autoClaimCalls) < 2 {
		t.Fatalf("expected startup and periodic XAUTOCLAIM calls, got %#v", client.autoClaimCalls)
	}
	if client.autoClaimCalls[1].startID != "42-0" || client.autoClaimCalls[1].minIdle != 10*time.Millisecond || client.autoClaimCalls[1].count != 2 {
		t.Fatalf("unexpected periodic XAUTOCLAIM call %#v", client.autoClaimCalls[1])
	}
	if len(client.acked) != 1 || client.acked[0] != "pending-2" {
		t.Fatalf("unexpected periodic reclaimed ACKs %#v", client.acked)
	}
}
