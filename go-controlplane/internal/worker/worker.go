// Package worker provides one-at-a-time Redis Streams consumption for a Go
// execution module. A processor owns failure reporting; messages are ACKed only
// after it has made a terminal outcome durable.
package worker

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"pixelscribe/go-controlplane/internal/queue"
)

const (
	defaultReadBlock       = 2 * time.Second
	defaultReclaimMinIdle  = 15 * time.Minute
	defaultProcessTimeout  = 14 * time.Minute
	defaultReclaimInterval = time.Minute
	defaultReclaimCount    = 10
	defaultReclaimMaxPages = 10
)

type StreamClient interface {
	EnsureGroup(ctx context.Context, stream, group string) error
	ReadGroup(ctx context.Context, stream, group, consumer string, block time.Duration) ([]queue.StreamMessage, error)
	AutoClaim(ctx context.Context, stream, group, consumer string, minIdle time.Duration, startID string, count int) (queue.AutoClaimResult, error)
	Ack(ctx context.Context, stream, group, messageID string) (bool, error)
	Delete(ctx context.Context, stream, messageID string) error
}

type Processor interface {
	Process(ctx context.Context, message queue.StreamMessage) error
}

type Worker struct {
	client         StreamClient
	processor      Processor
	stream         string
	group          string
	consumer       string
	readBlock      time.Duration
	processTimeout time.Duration
	reclaimIdle    time.Duration
	reclaimEvery   time.Duration
	reclaimCount   int
	reclaimPages   int
}

func New(client StreamClient, processor Processor, stream, group, consumer string) Worker {
	return NewWithConfig(client, processor, stream, group, consumer, Config{})
}

// Config controls polling and pending-entry recovery. Production defaults are
// deliberately conservative: image2 calls are bounded to ten minutes, and an
// active worker is not considered lost until it has been idle for fifteen.
type Config struct {
	ReadBlock       time.Duration
	ProcessTimeout  time.Duration
	ReclaimMinIdle  time.Duration
	ReclaimInterval time.Duration
	ReclaimCount    int
	ReclaimMaxPages int
}

func NewWithConfig(client StreamClient, processor Processor, stream, group, consumer string, config Config) Worker {
	if config.ReadBlock <= 0 {
		config.ReadBlock = defaultReadBlock
	}
	if config.ProcessTimeout <= 0 {
		config.ProcessTimeout = defaultProcessTimeout
	}
	if config.ReclaimMinIdle <= 0 {
		config.ReclaimMinIdle = defaultReclaimMinIdle
	}
	if config.ReclaimInterval <= 0 {
		config.ReclaimInterval = defaultReclaimInterval
	}
	if config.ReclaimCount <= 0 {
		config.ReclaimCount = defaultReclaimCount
	}
	if config.ReclaimMaxPages <= 0 {
		config.ReclaimMaxPages = defaultReclaimMaxPages
	}
	return Worker{
		client:         client,
		processor:      processor,
		stream:         stream,
		group:          group,
		consumer:       consumer,
		readBlock:      config.ReadBlock,
		processTimeout: config.ProcessTimeout,
		reclaimIdle:    config.ReclaimMinIdle,
		reclaimEvery:   config.ReclaimInterval,
		reclaimCount:   config.ReclaimCount,
		reclaimPages:   config.ReclaimMaxPages,
	}
}

func (worker Worker) Run(ctx context.Context) error {
	if err := worker.client.EnsureGroup(ctx, worker.stream, worker.group); err != nil {
		return fmt.Errorf("ensure image2 consumer group: %w", err)
	}
	claimCursor := "0-0"
	nextReclaim := time.Now()
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}

		if !time.Now().Before(nextReclaim) {
			nextCursor, err := worker.reclaim(ctx, claimCursor)
			if err != nil {
				if ctx.Err() != nil {
					return nil
				}
				slog.Error("Go image2 worker pending recovery failed", "error", err)
			} else {
				claimCursor = nextCursor
			}
			nextReclaim = time.Now().Add(worker.reclaimEvery)
			continue
		}

		block := worker.readBlock
		if untilReclaim := time.Until(nextReclaim); untilReclaim < block {
			block = untilReclaim
		}
		if block <= 0 {
			continue
		}
		if block < time.Millisecond {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(block):
			}
			continue
		}
		messages, err := worker.client.ReadGroup(ctx, worker.stream, worker.group, worker.consumer, block)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			slog.Error("Go image2 worker read failed", "error", err)
			time.Sleep(time.Second)
			continue
		}
		if len(messages) == 0 {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(25 * time.Millisecond):
			}
			continue
		}
		for _, message := range messages {
			worker.processAndAck(ctx, message)
		}
	}
}

func (worker Worker) reclaim(ctx context.Context, cursor string) (string, error) {
	if cursor == "" {
		cursor = "0-0"
	}
	for page := 0; page < worker.reclaimPages; page++ {
		result, err := worker.client.AutoClaim(
			ctx,
			worker.stream,
			worker.group,
			worker.consumer,
			worker.reclaimIdle,
			cursor,
			worker.reclaimCount,
		)
		if err != nil {
			return cursor, err
		}
		if len(result.DeletedIDs) > 0 {
			// These IDs were removed from the stream while pending, so Redis no
			// longer has enough data to make a terminal task callback. Surface
			// the condition for reconciliation instead of silently losing it.
			slog.Error("Go image2 worker found deleted pending stream entries", "stream", worker.stream, "group", worker.group, "count", len(result.DeletedIDs))
		}
		for _, message := range result.Messages {
			if ctx.Err() != nil {
				return cursor, nil
			}
			message.Reclaimed = true
			worker.processAndAck(ctx, message)
		}
		if result.NextStartID == "" || result.NextStartID == "0-0" {
			return "0-0", nil
		}
		cursor = result.NextStartID
	}
	return cursor, nil
}

func (worker Worker) processAndAck(ctx context.Context, message queue.StreamMessage) {
	// Keep the complete delivery lifecycle below the 15-minute PEL reclaim
	// threshold. This prevents an old consumer from ACKing a message that a
	// replacement worker has already reclaimed. Detach the active delivery
	// from shutdown cancellation so a SIGTERM stops new reads but gives the
	// current user-visible generation a chance to reach a terminal callback.
	processContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), worker.processTimeout)
	defer cancel()
	if err := worker.processor.Process(processContext, message); err != nil {
		// Leave the message pending. It is never ACKed before the processor
		// makes a user-visible terminal state durable.
		slog.Error("Go image2 worker process failed", "message_id", message.ID, "reclaimed", message.Reclaimed, "error", err)
		return
	}
	acknowledged, err := worker.client.Ack(processContext, message.Stream, worker.group, message.ID)
	if err != nil {
		slog.Error("Go image2 worker ACK failed", "message_id", message.ID, "reclaimed", message.Reclaimed, "error", err)
		return
	}
	if !acknowledged {
		slog.Warn("Go image2 worker ACK did not own pending entry", "message_id", message.ID, "reclaimed", message.Reclaimed)
		return
	}
	if message.Stream == queue.StreamImage2 || message.Stream == queue.StreamImageHeavy {
		// XACK makes the completion durable; XDEL then frees Redis memory
		// without ever trimming a pending image2 task.
		if err := worker.client.Delete(processContext, message.Stream, message.ID); err != nil {
			slog.Error("Go image2 worker stream cleanup failed", "message_id", message.ID, "error", err)
		}
	}
}
