# UploadQueueExample

Minimal React Native screen for `react-native-upload-queue`.

It is a demo, not a product: pick a file, enqueue, watch progress, pause,
resume, and cancel. Pair it with `../server`.

```text
Uploads

photo.jpg
████████░░ 80%
Uploading

invoice.pdf
░░░░░░░░░░ 0%
Pending

video.mp4
██████████ 100%
Completed
```

Wire `createSQLiteUploadStorage` with your RN SQLite driver and point
`createHttpUploadTransport` at the example server (`http://localhost:8787`).
Use `createManualConnectivity` or NetInfo to simulate offline.
