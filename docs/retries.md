# Retries

The HTTP adapter does not retry. The processor does.

## Classification

| Condition                         | Kind             | Retryable | Result     |
| --------------------------------- | ---------------- | --------- | ---------- |
| Network / TypeError               | `network`        | yes       | pending    |
| 408                               | `network`        | yes       | pending    |
| 429                               | `rate-limit`     | yes       | pending    |
| 500, 502, 503, 504                | `server`         | yes       | pending    |
| 400, 404 destination, 409, 422    | `validation`     | no        | failed     |
| 401                               | `authentication` | no        | blocked    |
| 403                               | `authorization`  | no        | failed     |
| Missing file                      | `file-not-found` | no        | failed     |
| Offline before attempt            | —                | —         | pending, attempts unchanged |

## Backoff

Default exponential strategy: `initialDelayMs * 2^(attempt-1)`, capped, with
jitter in `[0.5, 1.5]`.

Example without jitter: 2s, 4s, 8s, 16s, 32s.

## Retry-After

If the server sends `Retry-After`, that delay wins over local backoff.

## Offline

Being offline is not a failed attempt. Five minutes without signal must not
burn five retries.
