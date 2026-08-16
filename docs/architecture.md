# Architecture

`react-native-upload-queue` is a domain library first. The core runs in Node
during tests and in React Native at runtime. Adapters supply persistence,
HTTP, files, and connectivity.

## Module map

```text
UploadQueue                 lifecycle + user commands (pause/resume/cancel/retry)
  QueueCoordinator          single-flight process()
  QueueRunner               drains pending uploads up to the concurrency limit
    ConcurrencyController   max in-flight uploads
  WakeScheduler             one timer for the next scheduled retry
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

The claim is a **single conditional UPDATE**, not a transaction. Claims run
concurrently whenever `concurrency > 1`, and a driver that maps `transaction()`
onto a plain `BEGIN` on one connection rejects the overlap. `SQLiteDriver` only
needs `execute`.

The `processingToken` is a **fencing token**, not a label. Every write the
processor makes goes through `updateOwned(task, token)` / `updateProgress(...)`,
which match `WHERE processing_token = ?`. If the row changed hands — the user
paused or cancelled it, or recovery handed it to another worker — the write is
dropped and the processor reports the state that actually won. Without that, a
stalled worker waking up after recovery could overwrite whoever owns the upload
now, and a paused upload could resurrect itself.

Two `process()` calls on the same instance cannot duplicate work: the
coordinator ignores overlapping runs, and storage claiming is the durable
guard. A call that arrives while a drain is running asks that drain to take
another lap, so newly enqueued work is never stranded.

## Schema changes

`adapters/sqlite/migrations.ts` holds an ordered, append-only registry. Each
entry runs once per database and the recorded version advances after it. Adding
a column means appending an entry with its `ALTER TABLE` — `CREATE TABLE IF NOT
EXISTS` silently does nothing on a database that already has the table, so it
can only ever create the *initial* schema.

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
