# Milestones and initial issues

## Milestone 1 — Core

UploadTask, UploadStatus, UploadError, UploadStateMachine, UploadStorage,
MemoryUploadStorage, UploadQueue.

## Milestone 2 — Persistence

SQLite, migrations, mapping, recovery.

## Milestone 3 — Transport

HTTP, multipart, progress callback, AbortController, auth callback.

## Milestone 4 — Retry

Error classifier, exponential backoff, jitter, Retry-After, max attempts.

## Milestone 5 — Concurrency

Worker coordination, claiming, processing token, concurrency limit.

## Milestone 6 — Connectivity

NetInfo adapter, offline detection, automatic resume after reconnect.

## Milestone 7 — Example + release

Example app, documentation, CI, security docs, npm 0.1.0.

## Suggested GitHub issues

- feat: implement persistent upload task model
- feat: add upload state machine
- feat: implement SQLite storage adapter
- feat: add in-memory storage adapter
- feat: implement HTTP upload transport
- feat: add upload progress events
- feat: implement concurrency controller
- feat: add exponential backoff retry strategy
- feat: classify HTTP and network failures
- feat: recover abandoned uploads
- feat: add connectivity awareness
- feat: support pause and resume
- feat: support upload cancellation
- test: verify concurrency limits
- test: verify queue recovery after restart
- test: verify retry preserves idempotency key
- test: verify offline state does not consume retries
- docs: explain resilient vs resumable uploads
- docs: document server-side idempotency requirements
- docs: document authentication handling
