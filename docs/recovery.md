# Recovery

If the process dies while a row is `uploading`, that row stays `uploading`
until the next `initialize()` / `start()`.

Recovery rule:

```text
status = uploading
AND processingStartedAt < now - processingTimeoutMs
→ pending
```

Default timeout: 5 minutes.

A row whose `processingStartedAt` is 10 seconds old is left alone.

After recovery the next HTTP attempt starts at byte 0. Persisted `progress`
is visual only.

Crash simulation used in tests:

1. Process A enqueues and marks the task `uploading`.
2. Process A disappears.
3. Process B initializes, recovers abandoned rows, processes, completes.
