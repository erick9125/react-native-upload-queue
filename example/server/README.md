# Example upload server

Minimal Node HTTP server for local tests.

```bash
node example/server/index.mjs
```

`POST /uploads` accepts multipart (or any body), honors `Idempotency-Key`,
and can simulate failures:

| Query | Effect |
| ----- | ------ |
| `?fail=500` | HTTP 500 |
| `?fail=429` | HTTP 429 + `Retry-After: 5` |
| `?delay=3000` | wait 3s |
| `?close=1` | drop the connection |
