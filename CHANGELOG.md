# Changelog

## 0.1.0

- Persistent upload queue with SQLite and in-memory adapters.
- HTTP multipart transport that performs a single attempt per call.
- Retries with exponential backoff, jitter, and Retry-After support.
- Concurrency control, claiming, and duplicate-process protection.
- Pause, resume, cancel, and manual retry.
- Connectivity-aware processing that does not consume retries while offline.
- Recovery of abandoned uploads after application restart.
- Throttled progress events and coarse progress persistence.
- Stable idempotency keys across retries.
