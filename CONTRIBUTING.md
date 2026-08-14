# Contributing

Thanks for contributing to `react-native-upload-queue`.

## Development

```bash
npm install
npm run check
```

## Guidelines

- Keep the core independent of React Native, SQLite engines, NetInfo, and HTTP client details.
- Do not depend on `react-native-resilient-sync`.
- Persist uploads before attempting transport calls.
- Preserve idempotency keys across retries.
- Do not store access tokens, cookies, or multipart bodies.
- Classify errors in the processor, not in the HTTP adapter.
- Add unit, integration, concurrency, or recovery tests for behavioral changes.

## Pull requests

1. Keep the change scoped.
2. Update docs when public API behavior changes.
3. Ensure `npm run check:full` passes.
