# Architecture

`react-native-upload-queue` is a domain library first. The core runs in Node
during tests and in React Native at runtime. Adapters supply persistence,
HTTP, files, and connectivity.

## Module map

```text
UploadQueue
  QueueCoordinator          single-flight process()
  ConcurrencyController     max in-flight uploads
  UploadProcessor           claim → file check → transport → classify
  UploadStateMachine        legal transitions
  UploadEventEmitter        throttled progress + lifecycle events
  RetryStrategy             delay calculation only
```

## Storage

The engine never talks to SQLite directly:

```text
UploadQueue → UploadStorage → SQLite | Memory
```

Claiming is compare-and-set:

```text
pending → claim(processingToken) → uploading → process
```

Two `process()` calls on the same instance cannot duplicate work: the
coordinator ignores overlapping runs, and storage claiming is the durable
guard.

## Transport

`UploadTransport.upload` performs **one** attempt. It must not retry.
The processor owns backoff, `Retry-After`, max attempts, and `blocked`.

## Difference from react-native-resilient-sync

| resilient-sync              | upload-queue                          |
| --------------------------- | ------------------------------------- |
| JSON domain operations      | Files / multipart / binary            |
| POST /orders, PUT /users    | images, video, PDF, documents         |
| Conflict resolvers          | Progress, pause, cancel               |

They may be used together. Neither package imports the other.

## State machine

```text
pending    → uploading | paused | cancelled
uploading  → completed | pending | paused | blocked | failed | cancelled
paused     → pending | cancelled
blocked    → pending | failed | cancelled
failed     → pending | cancelled
completed  → (final)
cancelled  → (final)
```
