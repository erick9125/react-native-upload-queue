# React Native Upload Queue

A resilient, persistent file-upload queue for React Native.

Mobile uploads fail for reasons that have nothing to do with your API contract: the process dies, the radio drops, Wi-Fi hands off to cellular, the OS suspends the app, the token expires mid-request, or the server answers `429` / `500` after two minutes of transfer. A single `fetch()` cannot represent that lifecycle.

This library persists each upload locally, processes the queue with bounded concurrency, retries only recoverable failures, and recovers abandoned work after a restart.

**`0.1.0` promise:** persist file uploads on device and process them reliably with retries, progress tracking, concurrency control, and automatic recovery after application restarts.

| | |
| ------------- | ----------------------------------------- |
| Package | `@erickmorales91/react-native-upload-queue` |
| Runtime | React Native / TypeScript (Hermes-safe core) |
| Persistence | SQLite via a pluggable driver, plus an in-memory adapter for tests |
| Transport | HTTP multipart, one attempt per call |
| Connectivity | NetInfo adapter or a manual provider |
| License | MIT |

Also available in [Spanish](README.es.md).

This package does **not** depend on [`react-native-resilient-sync`](https://github.com/erick9125/react-native-resilient-sync). They belong to the same resilience family and can run side by side. Sync is for JSON domain operations. This library is for files.

---

## Table of contents

1. [When to use it](#when-to-use-it)
2. [The problem](#the-problem)
3. [What this library guarantees](#what-this-library-guarantees)
4. [What this is not](#what-this-is-not)
5. [Installation](#installation)
6. [Quick start](#quick-start)
7. [A complete example](#a-complete-example)
8. [Creating the queue](#creating-the-queue)
9. [Enqueueing uploads](#enqueueing-uploads)
10. [Processing the queue](#processing-the-queue)
11. [Pause, resume, cancel, retry](#pause-resume-cancel-retry)
12. [Events and UI progress](#events-and-ui-progress)
13. [Storage adapters](#storage-adapters)
14. [HTTP transport](#http-transport)
15. [Connectivity](#connectivity)
16. [Retries and error classification](#retries-and-error-classification)
17. [Authentication](#authentication)
18. [Recovery after restart](#recovery-after-restart)
19. [Idempotency](#idempotency)
20. [Progress semantics](#progress-semantics)
21. [Relationship with react-native-resilient-sync](#relationship-with-react-native-resilient-sync)
22. [Security](#security)
23. [Testing](#testing)
24. [API reference](#api-reference)
25. [Limitations and roadmap](#limitations-and-roadmap)
26. [License](#license)

---

## When to use it

Use this library when the product cannot afford to lose a file just because the device left coverage.

Typical workloads:

- field inspections: photos and evidence captured offline
- invoicing: PDFs attached in a warehouse or on the road
- healthcare / operations: documents and audio notes
- chat or ticketing: user-selected images and videos
- any flow where “the user already tapped send” must eventually reach the server

If the file is tiny, the network is guaranteed, and losing the request is acceptable, a direct `fetch` is enough. If the user may background the app, lose signal, or retry the same document, you need a queue.

---

## The problem

The naive implementation looks correct:

```ts
await fetch('/uploads', {
  method: 'POST',
  body: file,
});
```

It works while all of the following are true:

- the radio is stable
- the app stays in the foreground
- the request is short
- the file is small
- the server answers `2xx` on the first try

On a real device any of these can happen instead:

| Failure | What a raw `fetch` does | What the user experiences |
| ------- | ----------------------- | ------------------------- |
| App killed mid-upload | The request vanishes | The file is gone from the UI; they upload again |
| Tunnel / elevator / rural coverage | Throws a network error | They hammer retry and create duplicates |
| Wi-Fi → 4G handoff | The socket dies | Progress resets with no record of the attempt |
| `500` / `502` / `503` | The caller must invent retry logic | Inconsistent UX per screen |
| `429` + `Retry-After` | Usually ignored | The client DDoSes itself |
| `401` with a stale token | Five retries with the same header | Account lockouts, wasted battery |
| Temporary `file://` URI expires | Five retries of a missing file | Noise in logs, no useful diagnosis |

The library turns that into a durable state machine:

```text
Select file
      ↓
Persist the upload (SQLite)
      ↓
Enter the queue as pending
      ↓
Claim + attempt HTTP once
      ↓
Recoverable failure? persist + wait + retry
      ↓
Server confirms
      ↓
completed
```

---

## What this library guarantees

1. **Persist before transmit.** The record exists locally before the first byte is sent. Killing the app does not drop the intent to upload.

2. **One HTTP attempt per transport call.** `HttpUploadTransport` does not retry. The processor owns backoff, `Retry-After`, max attempts, and `blocked`. Those concerns stay separated on purpose.

3. **Claiming, not “select pending and hope”.** A row moves `pending → uploading` with a `processingToken`. Two `process()` calls on the same instance cannot double-send the same file.

4. **Concurrency is a hard cap.** `concurrency: 2` means at most two in-flight uploads for that queue instance, even if the UI fires `process()` three times.

5. **Offline does not burn retries.** Five minutes without signal does not consume five attempts. `attempts` increases only after a real upload try.

6. **Stable idempotency keys.** Attempt 1, 2 and 3 send the same `Idempotency-Key`. The server still has to implement the semantics; the client will not rotate the key.

7. **Structured errors.** Failures are `network | authentication | authorization | rate-limit | validation | server | file-not-found | cancelled | unknown`, with `retryable` and optional `statusCode` / `retryAfterMs`.

8. **Abandoned `uploading` rows are recovered.** After a crash, rows older than `processingTimeoutMs` return to `pending` and are attempted again.

9. **Tokens never touch SQLite.** `getAccessToken` runs on every attempt. The queue stores URI, destination, metadata, and status — not `Authorization`.

---

## What this is not

`0.1.0` is a **resilient upload queue**, not a **resumable upload protocol**.

Persisting `progress: 0.53` does not mean the next attempt continues at byte 53%. Unless the server speaks TUS, S3 multipart, or another chunk protocol, a retry starts from byte 0. Progress is for the UI.

Out of scope in this version:

- TUS, S3 multipart, chunked resume
- Firebase Storage, Supabase Storage, Cloudinary, AWS / Azure / GCS SDKs
- GraphQL or WebSockets
- native background-upload services
- encryption, image compression, video transcoding, thumbnails
- bidirectional sync
- a bundled UI or a required Redux / Zustand store

Those belong in later versions or in the application layer.

---

## Installation

```bash
npm install @erickmorales91/react-native-upload-queue
```

The core has **no** runtime dependency on `react-native`, NetInfo, or a specific SQLite engine. That is why the same code runs in Node tests.

For production you supply:

- a native SQLite module (`react-native-quick-sqlite`, `op-sqlite`, `expo-sqlite`, …) behind `SQLiteDriver`
- optionally `@react-native-community/netinfo`

Use the exported `createId()` when you need a UUID. `crypto.randomUUID()` is missing on Hermes.

---

## Quick start

```ts
import {
  createUploadQueue,
  createSQLiteUploadStorage,
  createHttpUploadTransport,
} from '@erickmorales91/react-native-upload-queue';

const queue = createUploadQueue({
  storage: createSQLiteUploadStorage({
    databaseName: 'uploads.db',
    openDriver: (databaseName) => openYourSqliteDriver(databaseName),
  }),
  transport: createHttpUploadTransport({
    baseUrl: 'https://api.example.com',
    getAccessToken: async () => auth.getAccessToken(),
  }),
  concurrency: 2,
  retry: {
    maxAttempts: 5,
    strategy: 'exponential',
  },
});

const upload = await queue.enqueue({
  fileUri: file.uri,
  fileName: file.name,
  mimeType: file.type,
  destination: '/uploads',
});

await queue.start();
```

`enqueue` returns immediately with an `id`. `start()` recovers abandoned rows, processes due work, and keeps listening for reconnects.

---

## A complete example

A field app that attaches an invoice photo and a PDF, shows progress, and survives going underground:

```ts
import NetInfo from '@react-native-community/netinfo';
import {
  createHttpUploadTransport,
  createNetInfoConnectivityProvider,
  createSQLiteUploadStorage,
  createUploadQueue,
  type UploadQueueEvent,
  type UploadTask,
} from '@erickmorales91/react-native-upload-queue';

const queue = createUploadQueue({
  storage: createSQLiteUploadStorage({
    databaseName: 'uploads.db',
    openDriver: openYourSqliteDriver,
  }),
  transport: createHttpUploadTransport({
    baseUrl: 'https://api.example.com',
    fieldName: 'file',
    idempotencyHeader: 'Idempotency-Key',
    getAccessToken: () => auth.getAccessToken(),
    timeoutMs: 60_000,
  }),
  connectivity: createNetInfoConnectivityProvider({ netInfo: NetInfo }),
  concurrency: 2,
  retry: {
    maxAttempts: 5,
    initialDelayMs: 2_000,
    maxDelayMs: 32_000,
    jitter: true,
  },
  recovery: {
    processingTimeoutMs: 5 * 60_000,
  },
});

export async function bootstrapUploads(): Promise<void> {
  queue.subscribe(onUploadEvent);
  await queue.start();
}

export async function submitEvidence(file: {
  uri: string;
  name: string;
  type: string;
  size?: number;
}): Promise<UploadTask> {
  return queue.enqueue({
    fileUri: file.uri,
    fileName: file.name,
    mimeType: file.type,
    ...(file.size !== undefined ? { size: file.size } : {}),
    destination: '/documents',
    metadata: {
      documentType: 'invoice',
      inspectionId: currentInspectionId,
    },
  });
}

function onUploadEvent(event: UploadQueueEvent): void {
  switch (event.type) {
    case 'upload.progress':
      updateRow(event.uploadId, {
        progress: event.progress,
        bytesUploaded: event.bytesUploaded,
      });
      break;
    case 'upload.completed':
      markDone(event.uploadId, event.remoteId);
      break;
    case 'upload.blocked':
      askUserToSignInAgain();
      break;
    case 'upload.failed':
      showFailure(event.uploadId, event.error.message);
      break;
    default:
      break;
  }
}
```

The screen only renders queue state. It does not own retry timers, NetInfo subscriptions, or SQLite writes.

```text
Uploads

photo.jpg      ████████░░  80%   uploading
invoice.pdf    ░░░░░░░░░░   0%   pending
video.mp4      ██████████ 100%   completed
```

---

## Creating the queue

```ts
const queue = createUploadQueue({
  storage,
  transport,
  connectivity,          // optional
  fileProvider,          // optional; default assumes the URI still exists
  retry: {
    maxAttempts: 5,
    strategy: 'exponential', // or 'fixed', or a custom RetryStrategy
    initialDelayMs: 2_000,
    maxDelayMs: 60_000,
    jitter: true,
  },
  concurrency: 2,
  recovery: { processingTimeoutMs: 5 * 60_000 },
  progress: {
    eventThrottleMs: 200,
    persistEveryPercent: 0.1,
    persistEveryMs: 500,
  },
  autoProcessOnReconnect: true,
});
```

| Option | Default | Role |
| ------ | ------- | ---- |
| `concurrency` | `2` | Max simultaneous uploads in this instance |
| `retry.maxAttempts` | `5` | Attempts that actually hit the network |
| `recovery.processingTimeoutMs` | `5 min` | When an `uploading` row is considered abandoned |
| `progress.eventThrottleMs` | `200` | UI events, not SQLite writes |
| `autoProcessOnReconnect` | `true` | Only while `start()` has been called |

---

## Enqueueing uploads

```ts
const upload = await queue.enqueue({
  fileUri: file.uri,
  fileName: file.name,
  mimeType: file.type,
  size: file.size,
  destination: '/documents',
  method: 'POST', // or 'PUT'
  metadata: { documentType: 'invoice' },
});

upload.id;
upload.status;          // 'pending'
upload.idempotencyKey;  // stable for every later attempt
```

The original file is **not** copied into SQLite. The queue stores the URI and small metadata (8 KiB cap). If the OS recycles a temporary URI, the next attempt fails as `file-not-found` instead of retrying a ghost path five times.

---

## Processing the queue

```ts
await queue.start();    // recover + process + listen for reconnect + schedule backoff
await queue.process();  // one drain of currently due work (ideal for tests)
await queue.stop();     // stop automatic scheduling; in-flight attempts finish
await queue.destroy();  // stop, unsubscribe, close storage
```

`process()` is single-flight. A second overlapping call returns `{ skipped: true, reason: 'busy' }` instead of launching a parallel worker pool.

If connectivity reports offline, `process()` returns `{ skipped: true, reason: 'offline' }` and leaves `attempts` at `0`.

---

## Pause, resume, cancel, retry

```ts
await queue.pause(uploadId);
// uploading | pending → paused
// the in-flight HTTP request is aborted with AbortController

await queue.resume(uploadId);
// paused → pending
// the scheduler decides when it runs; this is not paused → uploading

await queue.cancel(uploadId);
// → cancelled (terminal)
// the original file on disk is not deleted

await queue.retry(uploadId);
// failed | blocked → pending
// the file URI is checked first; missing files throw FileNotFoundError
```

Illegal transitions throw `InvalidUploadStateError`. `completed → uploading` is rejected.

---

## Events and UI progress

```ts
const unsubscribe = queue.subscribe((event) => {
  switch (event.type) {
    case 'upload.queued':
    case 'upload.started':
    case 'upload.progress':
    case 'upload.retry_scheduled':
    case 'upload.completed':
    case 'upload.failed':
    case 'upload.paused':
    case 'upload.cancelled':
    case 'upload.blocked':
      break;
  }
});
```

Progress events are throttled (default 200 ms). SQLite is updated about every 10% or 500 ms — never per byte.

A listener that throws is swallowed. The queue will not abort a pass because the UI crashed.

---

## Storage adapters

The engine talks only to `UploadStorage`. SQLite is an adapter, not the engine.

### In-memory (tests)

```ts
import { createMemoryUploadStorage, createUploadQueue } from '@erickmorales91/react-native-upload-queue';

const queue = createUploadQueue({
  storage: createMemoryUploadStorage(),
  transport: fakeTransport,
});
```

The memory adapter is a honest stand-in: duplicate ids fail, missing updates fail, claims are compare-and-set, and metadata round-trips through JSON — the same contract SQLite implements.

### SQLite (production)

```ts
import { createSQLiteUploadStorage, type SQLiteDriver } from '@erickmorales91/react-native-upload-queue';

const storage = createSQLiteUploadStorage({
  databaseName: 'uploads.db',
  openDriver: async (databaseName) => openYourSqliteDriver(databaseName),
});
```

Or pass a ready driver:

```ts
createSQLiteUploadStorage({ driver: myDriver });
```

Required surface:

```ts
interface SQLiteDriver {
  execute(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[]; rowsAffected?: number }>;
  transaction<T>(fn: (tx: SQLiteDriver) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
```

Sketch for a native module:

```ts
function createQuickSqliteDriver(databaseName: string): SQLiteDriver {
  const db = QuickSQLite.open(databaseName);

  return {
    async execute(sql, params = []) {
      const result = db.execute(sql, params as unknown[]);
      return {
        rows: result.rows?._array ?? [],
        rowsAffected: result.rowsAffected,
      };
    },
    async transaction(fn) {
      db.execute('BEGIN');
      try {
        const value = await fn(this);
        db.execute('COMMIT');
        return value;
      } catch (error) {
        db.execute('ROLLBACK');
        throw error;
      }
    },
    async close() {
      db.close();
    },
  };
}
```

---

## HTTP transport

The adapter builds multipart, attaches the idempotency header, reads a fresh token, honors abort/timeout, and returns **one** status code. It does not loop.

```ts
createHttpUploadTransport({
  baseUrl: 'https://api.example.com',
  getAccessToken: () => auth.getAccessToken(),
  idempotencyHeader: 'Idempotency-Key',
  fieldName: 'file',
  timeoutMs: 60_000,
  defaultHeaders: { 'X-Client': 'mobile' },
});
```

On React Native the default body is a `{ uri, name, type }` FormData part. In Node tests it falls back to a `Blob`. For a custom payload, pass `buildBody`.

---

## Connectivity

The core never imports NetInfo.

```ts
import NetInfo from '@react-native-community/netinfo';
import {
  createManualConnectivity,
  createNetInfoConnectivityProvider,
} from '@erickmorales91/react-native-upload-queue';

createNetInfoConnectivityProvider({ netInfo: NetInfo });

const connectivity = createManualConnectivity(true);
connectivity.setOnline(false); // tests and “simulate offline” in the example app
```

While offline, due work stays `pending`. After `start()`, coming back online drains the queue.

---

## Retries and error classification

| Condition | Kind | Retryable | Result |
| --------- | ---- | --------- | ------ |
| Network / `TypeError` | `network` | yes | `pending` + backoff |
| `408` | `network` | yes | `pending` |
| `429` | `rate-limit` | yes | `pending`, `Retry-After` wins over local backoff |
| `500` `502` `503` `504` | `server` | yes | `pending` |
| `400` `404` `409` `422` | `validation` | no | `failed` |
| `401` | `authentication` | no | `blocked` |
| `403` | `authorization` | no | `failed` |
| Missing file | `file-not-found` | no | `failed` |
| Offline before the attempt | — | — | `pending`, `attempts` unchanged |

Default exponential series without jitter: 2s, 4s, 8s, 16s, 32s (capped). Jitter is on by default to avoid a retry stampede.

`Retry-After` always beats the local strategy.

See [docs/retries.md](docs/retries.md).

---

## Authentication

```ts
createHttpUploadTransport({
  baseUrl: 'https://api.example.com',
  getAccessToken: async () => auth.getAccessToken(),
});
```

The callback runs on **every** attempt so an expired token is not reused from the row. In `0.1.0`, `401` moves the task to `blocked`. There is no automatic refresh; that is planned for `0.2.0`. The UI should send the user through login and then `queue.retry(id)`.

---

## Recovery after restart

If the process dies while a row is `uploading`, it stays `uploading` on disk.

On the next `initialize()` / `start()`:

```text
status = uploading
AND processingStartedAt < now - processingTimeoutMs
        ↓
pending  (progress reset; next HTTP attempt starts at byte 0)
```

A row whose `processingStartedAt` is 10 seconds old is left alone. Default timeout: 5 minutes.

See [docs/recovery.md](docs/recovery.md).

---

## Idempotency

Each task gets a stable `idempotencyKey` at enqueue time (`createId()` / UUID). Retries reuse it. The HTTP adapter sends:

```http
Idempotency-Key: <key>
```

The queue cannot make the server idempotent. If the client crashes after the server stored the file but before the client recorded `completed`, recovery will send the same key again. A correct server returns the original result instead of storing a second object.

Document this with your backend. See [docs/idempotency.md](docs/idempotency.md).

---

## Progress semantics

| Layer | Cadence | Meaning |
| ----- | ------- | ------- |
| UI events | ~200 ms | Paint a bar |
| SQLite | ~10% or 500 ms | Survive a restart with a visual hint |
| Next HTTP attempt | from byte 0 | Unless you add a resumable protocol later |

Do not tell users “resume from 53%” in `0.1.0`. Tell them “the upload will be retried”.

---

## Relationship with react-native-resilient-sync

| `react-native-resilient-sync` | `react-native-upload-queue` |
| ----------------------------- | --------------------------- |
| JSON domain operations | Files, images, video, PDF |
| `POST /orders`, `PUT /users` | Multipart binary transfer |
| Conflict resolvers | Progress, pause, cancel |
| Payload in the row | URI + small metadata, never the bytes |

Use both in the same app when you have notes **and** attachments. Import neither from the other.

---

## Security

Never persist:

- access / refresh tokens
- `Authorization` headers
- cookies or passwords
- the multipart body

Store URI, destination, and small structured metadata only. The default logger is a no-op; a custom logger should log `uploadId`, `status`, and `attempts` — not `console.log(task)`.

See [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md).

---

## Testing

```bash
npm test
npm run check:full
```

The suite covers the state machine, backoff, HTTP classification, pause/cancel/retry, offline (attempts stay at 0), concurrency (`peak === 3` with 20 files), claiming under overlapping `process()`, and crash recovery (process A dies `uploading`, process B completes the same idempotency key).

For application tests, inject `createMemoryUploadStorage()`, `createManualConnectivity()`, and a fake `UploadTransport`.

---

## API reference

```ts
interface UploadQueue {
  initialize(): Promise<void>;
  enqueue(input: EnqueueUploadInput): Promise<UploadTask>;
  start(): Promise<void>;
  stop(): Promise<void>;
  process(): Promise<UploadProcessResult>;
  pause(uploadId: string): Promise<UploadTask>;
  resume(uploadId: string): Promise<UploadTask>;
  cancel(uploadId: string): Promise<UploadTask>;
  retry(uploadId: string): Promise<UploadTask>;
  get(uploadId: string): Promise<UploadTask | null>;
  list(): Promise<readonly UploadTask[]>;
  purgeCompleted(olderThanIso?: string): Promise<number>;
  subscribe(listener: (event: UploadQueueEvent) => void): () => void;
  destroy(): Promise<void>;
}

type UploadStatus =
  | 'pending'
  | 'uploading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';
```

Deeper notes: [docs/architecture.md](docs/architecture.md), [docs/limitations.md](docs/limitations.md).

---

## Limitations and roadmap

**`0.2.0`:** auth refresh hooks, priorities, per-upload headers, cleanup policy, queue-level pause/resume.

**`0.3.0`:** chunked uploads, persisted chunks, resume tokens, server capability adapter.

---

## License

MIT. See [CONTRIBUTING.md](CONTRIBUTING.md) if you are changing behavior.
