# Idempotency

Every `UploadTask` receives a stable `idempotencyKey` when it is enqueued.
Retries reuse that key. A new enqueue creates a new key.

The HTTP adapter sends:

```http
Idempotency-Key: <key>
```

Override the header name with `idempotencyHeader` on
`createHttpUploadTransport`.

The upload queue preserves a stable idempotency key across retries. The
server must implement idempotency semantics for this key if duplicate
uploads must be prevented.

This library cannot detect or collapse duplicate bodies on the server.
If the client crashes after the server stored the file but before the
client recorded `completed`, recovery will send the same key again. A
correct server should return the original result instead of storing a
second object.
