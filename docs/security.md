# Security

## Never persist

- access tokens
- refresh tokens
- `Authorization` headers
- cookies
- passwords
- the multipart body

Authentication is obtained dynamically via `getAccessToken` on each
attempt.

## Where the token is sent

`task.destination` must be a path under `baseUrl`. An absolute URL is rejected
unless you opt in with `allowAbsoluteDestinations: true`, and even then the
`Authorization` header is only attached when the destination resolves to the
base URL's own origin.

This matters when destinations come from data you do not fully control — a
server response, a deep link, a push payload. Without the rule, a destination of
`https://attacker.example/collect` would receive the bearer token.

## Metadata

Metadata is for small structured values (document type, local ids). The
default limit is 8 KiB. Do not put file contents or PII blobs there.

## Logging

The default logger is a no-op. Custom loggers should log `uploadId`,
`status`, and `attempts` only. Do not `console.log(task)`.
