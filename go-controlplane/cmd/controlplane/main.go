package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"pixelscribe/go-controlplane/internal/image2"
	"pixelscribe/go-controlplane/internal/image2worker"
	"pixelscribe/go-controlplane/internal/imageheavyworker"
	"pixelscribe/go-controlplane/internal/queue"
	"pixelscribe/go-controlplane/internal/tasks"
	streamworker "pixelscribe/go-controlplane/internal/worker"
)

type configuration struct {
	ListenAddr               string
	RedisURL                 string
	InternalSecret           string
	MaxPayloadBytes          int64
	Image2WorkerEnabled      bool
	Image2CallbackURL        string
	Image2WorkerConsumer     string
	Image2MaxInputBytes      int64
	Image2MaxOutputBytes     int64
	Image2ShutdownGrace      time.Duration
	ImageHeavyWorkerEnabled  bool
	ImageHeavyWorkerConsumer string
	ImageHeavyMaxInputBytes  int64
	ImageHeavyMaxOutputBytes int64
	ImageHeavyShutdownGrace  time.Duration
	QueueCapacity            int64
}

type enqueueRequest struct {
	TaskID          string         `json:"task_id"`
	TaskType        string         `json:"task_type"`
	UserID          string         `json:"user_id"`
	Priority        string         `json:"priority"`
	BillingMode     string         `json:"billing_mode"`
	ExecutionTarget string         `json:"execution_target"`
	Payload         map[string]any `json:"payload"`
}

func main() {
	cfg := configuration{
		ListenAddr:               envOrDefault("GO_CONTROL_PLANE_LISTEN_ADDR", "127.0.0.1:8082"),
		RedisURL:                 requiredEnv("REDIS_URL"),
		InternalSecret:           requiredEnv("GO_CONTROL_PLANE_SHARED_SECRET"),
		MaxPayloadBytes:          1 << 20,
		Image2WorkerEnabled:      boolEnv("GO_IMAGE2_WORKER_ENABLED"),
		Image2CallbackURL:        strings.TrimRight(strings.TrimSpace(os.Getenv("GO_IMAGE2_BACKEND_URL")), "/"),
		Image2WorkerConsumer:     image2ConsumerName(),
		Image2MaxInputBytes:      int64Env("GO_IMAGE2_WORKER_MAX_INPUT_BYTES"),
		Image2MaxOutputBytes:     int64Env("GO_IMAGE2_WORKER_MAX_OUTPUT_BYTES"),
		Image2ShutdownGrace:      durationSecondsEnv("GO_IMAGE2_WORKER_SHUTDOWN_GRACE_SECONDS", 15*time.Minute),
		ImageHeavyWorkerEnabled:  boolEnv("GO_IMAGE_HEAVY_WORKER_ENABLED"),
		ImageHeavyWorkerConsumer: heavyConsumerName(),
		ImageHeavyMaxInputBytes:  int64Env("GO_IMAGE_HEAVY_WORKER_MAX_INPUT_BYTES"),
		ImageHeavyMaxOutputBytes: int64Env("GO_IMAGE_HEAVY_WORKER_MAX_OUTPUT_BYTES"),
		ImageHeavyShutdownGrace:  durationSecondsEnv("GO_IMAGE_HEAVY_WORKER_SHUTDOWN_GRACE_SECONDS", 15*time.Minute),
		QueueCapacity:            int64Env("QUEUE_GLOBAL_MAX_ENTRIES"),
	}
	client, err := queue.NewRedisClient(cfg.RedisURL)
	if err != nil {
		slog.Error("invalid redis configuration", "error", err)
		os.Exit(1)
	}
	defer client.Close()

	jobs := queue.NewStreamQueue(client, cfg.QueueCapacity)
	taskStore := tasks.NewStore(client)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(writer http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		if err := client.Ping(ctx); err != nil {
			writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /internal/v1/jobs", func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Control-Plane-Secret") != cfg.InternalSecret {
			writeJSON(writer, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		request.Body = http.MaxBytesReader(writer, request.Body, cfg.MaxPayloadBytes)
		defer request.Body.Close()

		var input enqueueRequest
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
		if err := validateEnqueueRequest(input); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		messageID, err := jobs.Enqueue(request.Context(), queue.Job{
			TaskID: input.TaskID, TaskType: input.TaskType, UserID: input.UserID,
			Priority: input.Priority, BillingMode: input.BillingMode,
			ExecutionTarget: input.ExecutionTarget, Payload: input.Payload,
		})
		if err != nil {
			slog.Error("enqueue failed", "task_id", input.TaskID, "task_type", input.TaskType, "error", err)
			var queueFull *queue.QueueCapacityError
			if errors.As(err, &queueFull) {
				writer.Header().Set("Retry-After", "5")
				writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "queue is temporarily full"})
				return
			}
			writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "queue unavailable"})
			return
		}
		writeJSON(writer, http.StatusAccepted, map[string]string{"message_id": messageID, "status": "queued"})
	})
	mux.HandleFunc("GET /internal/v1/tasks/{taskID}", func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Control-Plane-Secret") != cfg.InternalSecret {
			writeJSON(writer, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		task, found, err := taskStore.GetForUser(
			request.Context(), request.PathValue("taskID"), request.Header.Get("X-Task-User-ID"),
		)
		if err != nil {
			slog.Error("task lookup failed", "error", err)
			writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "task store unavailable"})
			return
		}
		if !found {
			writeJSON(writer, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		writeJSON(writer, http.StatusOK, task)
	})

	server := &http.Server{Addr: cfg.ListenAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	rootContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	workerErrors := make(chan error, 2)
	workerDone := make(chan struct{})
	heavyWorkerDone := make(chan struct{})
	if cfg.Image2WorkerEnabled {
		if cfg.Image2CallbackURL == "" {
			slog.Error("GO_IMAGE2_BACKEND_URL is required when the Go image2 worker is enabled")
			os.Exit(1)
		}
		callbacks, err := image2worker.NewHTTPCallbacks(cfg.Image2CallbackURL, cfg.InternalSecret, nil)
		if err != nil {
			slog.Error("invalid Go image2 callback configuration", "error", err)
			os.Exit(1)
		}
		processor, err := image2worker.NewProcessor(callbacks, image2.NewClient(nil), image2worker.Config{
			MaxInputBytes:  cfg.Image2MaxInputBytes,
			MaxOutputBytes: cfg.Image2MaxOutputBytes,
		})
		if err != nil {
			slog.Error("initialize Go image2 worker", "error", err)
			os.Exit(1)
		}
		goWorker := streamworker.New(
			client,
			processor,
			queue.StreamImage2,
			"image2-go",
			cfg.Image2WorkerConsumer,
		)
		go func() {
			defer close(workerDone)
			if err := goWorker.Run(rootContext); err != nil {
				workerErrors <- err
			}
		}()
		slog.Info("Go image2 worker enabled", "stream", queue.StreamImage2, "consumer", cfg.Image2WorkerConsumer)
	} else {
		close(workerDone)
	}
	if cfg.ImageHeavyWorkerEnabled {
		callbacks, err := imageheavyworker.NewHTTPCallbacks(cfg.Image2CallbackURL, cfg.InternalSecret, nil)
		if err != nil {
			slog.Error("invalid Go image heavy callback configuration", "error", err)
			os.Exit(1)
		}
		processor, err := imageheavyworker.NewProcessor(callbacks, imageheavyworker.NewReplicateGenerator(nil), imageheavyworker.Config{MaxInputBytes: cfg.ImageHeavyMaxInputBytes, MaxOutputBytes: cfg.ImageHeavyMaxOutputBytes, Timeout: 8 * time.Minute})
		if err != nil {
			slog.Error("initialize Go image heavy worker", "error", err)
			os.Exit(1)
		}
		heavyWorker := streamworker.New(client, processor, queue.StreamImageHeavy, "image-heavy-go", cfg.ImageHeavyWorkerConsumer)
		go func() {
			defer close(heavyWorkerDone)
			if err := heavyWorker.Run(rootContext); err != nil {
				workerErrors <- err
			}
		}()
		slog.Info("go image heavy worker enabled", "stream", queue.StreamImageHeavy, "consumer", cfg.ImageHeavyWorkerConsumer)
	} else {
		close(heavyWorkerDone)
	}

	serverErrors := make(chan error, 1)
	slog.Info("go control plane listening", "address", server.Addr)
	go func() { serverErrors <- server.ListenAndServe() }()
	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server stopped", "error", err)
		}
		stop()
	case err := <-workerErrors:
		slog.Error("Go image2 worker stopped", "error", err)
		stop()
	case <-rootContext.Done():
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownContext); err != nil {
		slog.Error("server shutdown failed", "error", err)
	}
	if cfg.Image2WorkerEnabled {
		select {
		case <-workerDone:
			slog.Info("Go image2 worker drained")
		case <-time.After(cfg.Image2ShutdownGrace):
			slog.Error("Go image2 worker did not drain before shutdown grace expired", "grace", cfg.Image2ShutdownGrace)
		}
	}
	if cfg.ImageHeavyWorkerEnabled {
		select {
		case <-heavyWorkerDone:
			slog.Info("go image heavy worker drained")
		case <-time.After(cfg.ImageHeavyShutdownGrace):
			slog.Error("go image heavy worker did not drain before shutdown grace expired", "grace", cfg.ImageHeavyShutdownGrace)
		}
	}
}

func requiredEnv(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		slog.Error("required environment value is empty", "name", name)
		os.Exit(1)
	}
	return value
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func boolEnv(name string) bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv(name)), "true")
}

func int64Env(name string) int64 {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return 0
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		slog.Warn("ignoring invalid positive integer environment value", "name", name)
		return 0
	}
	return parsed
}

func durationSecondsEnv(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	seconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil || seconds <= 0 {
		slog.Warn("ignoring invalid positive duration seconds", "name", name)
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

func image2ConsumerName() string {
	if configured := strings.TrimSpace(os.Getenv("GO_IMAGE2_WORKER_CONSUMER")); configured != "" {
		return configured
	}
	hostname, err := os.Hostname()
	if err != nil || strings.TrimSpace(hostname) == "" {
		hostname = "host"
	}
	return fmt.Sprintf("go-image2-%s-%d", hostname, os.Getpid())
}

func heavyConsumerName() string {
	if configured := strings.TrimSpace(os.Getenv("GO_IMAGE_HEAVY_WORKER_CONSUMER")); configured != "" {
		return configured
	}
	hostname, err := os.Hostname()
	if err != nil || strings.TrimSpace(hostname) == "" {
		hostname = "host"
	}
	return fmt.Sprintf("go-image-heavy-%s-%d", hostname, os.Getpid())
}

func validateEnqueueRequest(request enqueueRequest) error {
	if strings.TrimSpace(request.TaskID) == "" || strings.TrimSpace(request.TaskType) == "" || strings.TrimSpace(request.UserID) == "" {
		return errors.New("task_id, task_type, and user_id are required")
	}
	if target := strings.TrimSpace(request.ExecutionTarget); target != "" && target != queue.ExecutionTargetImage2 && target != queue.ExecutionTargetImageHeavy {
		return fmt.Errorf("unsupported execution target %q", target)
	}
	if request.ExecutionTarget == queue.ExecutionTargetImage2 && request.TaskType != "generate" {
		return errors.New("go-image2 execution target only accepts generate tasks")
	}
	if request.ExecutionTarget == queue.ExecutionTargetImageHeavy && request.TaskType != "touch-replace" && request.TaskType != "touch-recolor" {
		return errors.New("go-image-heavy execution target only accepts touch replace/recolor tasks")
	}
	if err := queue.ValidatePayload(request.Payload); err != nil {
		return err
	}
	return nil
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
