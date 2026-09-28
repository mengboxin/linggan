# Go Control Plane

This service owns Redis Streams writes and the first executable Go migration
slice for the platform's single image2 model. It deliberately keeps image
bytes out of Redis: jobs only contain object-storage references.

Python remains the authority for authentication, task records, credits,
history, public-gallery submission, asset variants, and SSE user events. Go
only executes a narrow, reversible upstream image2 call.

## Go Image2 Worker

The worker is disabled by default. When enabled, it consumes only the
dedicated `queue:image2` stream using the `image2-go` consumer group. Python
workers continue to consume `queue:high`, `queue:normal`, and `queue:low`, so
the two runtimes never compete for the same upstream model call.

Only these jobs are eligible:

- `task_type=generate`
- source ending in `image2_shortcut`
- exactly one output
- no LLM or vision model
- no visual-review pass
- object references only, with no Base64 image fields

The Go worker asks Python for a short-lived runtime lease after it owns the
job. The lease contains the resolved Responses endpoint, API key, model, tool
options, and final prompt. None of those secrets are written to Redis or logs.
After an image succeeds, Go calls Python's internal completion callback. Python
archives the result and atomically completes the task; the task terminal
outbox then charges once with idempotency key
`task-terminal:<task_id>:charge`, releases the task reservation, and emits the
existing user events. A cancellation that wins the terminal transition cannot
be charged by a delayed Go callback.

`queue:image2` deliberately has no approximate `MAXLEN` trim: trimming can
remove a Redis Stream entry that is still pending. After a terminal callback,
the worker `XACK`s the entry and then `XDEL`s it, so completed work releases
Redis memory without risking an in-flight task. A delivery is bounded to 14
minutes, below the 15-minute pending-entry recovery threshold.

On `SIGTERM`, the worker stops reading new entries but is allowed to finish
the active delivery before `GO_IMAGE2_WORKER_SHUTDOWN_GRACE_SECONDS` expires
(900 seconds by default). The Compose service sets the same 15-minute stop
grace period; deployments outside Compose need an equivalent termination
grace period.

Each Go worker container executes one image2 job at a time. This keeps the
large input/output buffers predictable; increase throughput by adding worker
replicas rather than increasing per-process image concurrency.

## Go Heavy Image-Edit Worker

When `GO_IMAGE_HEAVY_WORKER_ENABLED=true`, the same control-plane process also
consumes `queue:image-heavy` with the `image-heavy-go` group. Only asset-backed
`touch-replace` and `touch-recolor` jobs are eligible. The worker calls the
configured Flux Fill Replicate endpoint with one job at a time, then sends the
result to Python for archival and task completion. `touch-remove` remains on
Python because its LaMa-to-SDXL fallback is provider-specific; batch
segmentation remains on its existing queue because it is not an image2 call.

## Build And Run

```powershell
cd go-controlplane
go test ./...
go build ./cmd/controlplane
$env:REDIS_URL = "redis://localhost:6379/0"
$env:GO_CONTROL_PLANE_SHARED_SECRET = "replace-with-a-long-random-secret"
./controlplane.exe
```

On direct Linux deployments, the service listens on `127.0.0.1:8082` by
default. Docker explicitly overrides that to `:8082` for the internal Compose
network. It is internal-only and requires
`X-Control-Plane-Secret` for its HTTP endpoints.

To run the worker locally, add:

```powershell
$env:GO_IMAGE2_WORKER_ENABLED = "true"
$env:GO_IMAGE2_BACKEND_URL = "http://localhost:8000"
$env:GO_IMAGE2_WORKER_MAX_INPUT_BYTES = "52428800"
$env:GO_IMAGE2_WORKER_MAX_OUTPUT_BYTES = "33554432"
$env:GO_IMAGE2_WORKER_SHUTDOWN_GRACE_SECONDS = "900"
```

In Docker, `docker-compose.yml` supplies
`GO_IMAGE2_BACKEND_URL=http://backend:8000` for the `go-controlplane` service.

For a direct Linux deployment, copy `.env.example` to `.env`, set the shared
secret to the same value as the Python backend, and run `./start.sh`. The
wrapper keeps the secret out of Supervisor configuration files.

## Safe Rollout

1. Apply the Python migrations, including
   `20260731_001_credit_transaction_idempotency.sql`.
2. Confirm new `generate` jobs use `image_assets` and no Base64 in Redis.
3. Set `GO_CONTROL_PLANE_URL` and `GO_CONTROL_PLANE_SHARED_SECRET` on the
   backend and Go service.
4. Start `go-controlplane` with its Docker profile, while
   `GO_IMAGE2_WORKER_ENABLED=false` everywhere.
5. Enable `GO_IMAGE2_WORKER_ENABLED=true` on both services for a small canary.
6. Watch `queue:image2`, task terminal states, asset archival, and credit
   transactions before widening the canary.

Scale only after the canary is clean, for example:

```powershell
docker compose --profile go-controlplane up -d --scale go-controlplane=2
```

To stop new Go work, set the backend's `GO_IMAGE2_WORKER_ENABLED=false` first.
Leave the Go worker running until it drains pending `queue:image2` work. Do
not move those messages onto the Python priority streams because a task may
already hold the one-time image2 execution lock.
