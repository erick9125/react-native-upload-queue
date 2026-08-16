# Changelog

## 0.1.0

First public release.

### Features

- Persistent upload queue with SQLite and in-memory adapters.
- HTTP multipart transport that performs a single attempt per call.
- Retries with exponential backoff, jitter, and Retry-After support.
- Concurrency control, claiming, and duplicate-process protection.
- Pause, resume, cancel, and manual retry.
- Connectivity-aware processing that does not consume retries while offline.
- Recovery of abandoned uploads after application restart.
- Throttled progress events and coarse progress persistence.
- Stable idempotency keys across retries.

### Behaviour worth knowing before you integrate

- **The default multipart body only works in React Native**, whose networking
  layer streams `file://` URIs natively. Anywhere else — Node, web, tests — pass
  `createHttpUploadTransport({ buildBody })` and build the body yourself. The
  builder throws rather than silently uploading the URI string.
- **`task.destination` must be a path under `baseUrl`.** Absolute URLs are
  rejected unless you set `allowAbsoluteDestinations: true`, and even then the
  access token is only ever sent to the base URL's own origin.
- **401 and 403 park the upload in `blocked`, not `failed`.** Neither can be
  fixed by retrying on the same credentials, so they wait for the host to
  refresh the token or fix permissions, then call `retry()`.
- **Custom `UploadStorage` implementations** must provide `updateOwned`,
  `updateProgress`, `recoverAbandoned` and `getEarliestNextAttemptAt` alongside
  the basic CRUD. `SQLiteDriver` only needs `execute`; `transaction` is optional
  and never used.

### Hardening applied before this release

A pre-release QA pass found and fixed the following. They are recorded here
because they describe guarantees the library now makes, not because any of them
ever shipped.

- Claim tokens are enforced. `UploadStorage` gained `updateOwned(task, token)`,
  and every write the processor makes goes through it, so a worker that lost its
  claim can no longer overwrite whoever holds it now.
- Pausing or cancelling an upload is no longer undone by the attempt that was in
  flight. Previously a paused upload resurrected itself whenever the attempt
  failed with anything other than an abort.
- `concurrency > 1` no longer breaks the SQLite adapter. `claim()` is a single
  atomic conditional UPDATE instead of an explicit transaction, so overlapping
  claims cannot produce "cannot start a transaction within a transaction".
- Background processing triggered by `enqueue`, `resume`, `retry`, the wake timer
  and reconnection can no longer surface as an unhandled rejection.
- A single upload throwing no longer aborts the drain and orphans the rest of the
  batch. Faults are counted in the new `UploadProcessResult.errored`.
- `stop()` and `destroy()` abort in-flight attempts and wait for them to unwind
  before returning, so storage is never closed underneath a running upload.
  Uploads interrupted by shutdown return to `pending` without spending an attempt.
- The drain loop no longer spins on an upload that lands back on `pending` within
  the same pass.

- An upload enqueued while a drain was already running could be left untouched
  until the next external trigger: it has no `nextAttemptAt`, so the wake timer
  never fired for it. The running pass now takes another lap.
- `scheduleWake()` no longer loads the whole queue to compute one minimum. With
  300 completed rows on device, `start()` went from ~5.2 ms and a full table
  scan to ~0.8 ms and none.
- Recovery of abandoned uploads is a single UPDATE instead of one full-row write
  per stale upload, sequentially, at boot.
- Progress persistence writes four columns instead of rewriting all 23 and
  re-serializing metadata and the last error on every tick.
- The transport no longer leaks its deadline timer and abort listener after a
  successful upload, and no longer calls `AbortSignal.timeout` before checking
  whether `AbortSignal.any` exists — which threw on runtimes that have neither.
- A transport deadline is reported as a retryable network failure by type,
  instead of relying on the runtime putting "timeout" in the abort message.
- `purgeCompleted(olderThanIso)` ages rows by `completedAt`, not by `updatedAt`,
  which any later write used to bump.
- `maxAttempts` falls back to the schema default rather than 0 when a row has no
  value, which silently disabled retries for that upload.
- `insert()` reports IO and disk faults as themselves instead of probing with a
  SELECT and calling every failure a duplicate.
- `FileNotFoundError` names the file that went missing.
- `parseRetryAfterHeader` resolves HTTP dates against the injected clock.

### Shaped by the same pass

- `SQLiteDriver.transaction` is optional; the adapter never opens one.
- `UploadProcessResult` gained `errored`, and no longer counts uploads that
  another worker had already claimed. `UploadSkipReason` dropped the unused
  `'stopped'`.
- `upload.completed` carries the parsed server `response`.
- `retry()` accepts an upload that is already `pending` and resets its attempts,
  matching how `resume()` behaves.
- `nowIso()` requires an explicit date so callers cannot bypass the `Clock`.
- The published tarball no longer ships `src/` alongside `dist/`.

### Internal

- SQLite migrations run from an ordered registry, applying only what a database
  is missing. `CREATE TABLE IF NOT EXISTS` alone could never have added a column
  to an existing install.
- One column table drives INSERT, UPDATE and their parameter lists, with a
  round-trip test that fails if a model field stops being persisted.
- The drain loop and wake timer moved into `QueueRunner` and `WakeScheduler`.
- `errors/` no longer imports from `core/processor/`, breaking a module cycle.
- CI runs `test:coverage`, so the declared 90%/85% thresholds finally gate the
  build, plus `npm audit`.
- The release workflow refuses to publish when the git tag and the
  `package.json` version disagree.
