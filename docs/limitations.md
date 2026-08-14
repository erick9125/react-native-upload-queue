# Limitations (0.1.0)

This release is a **resilient upload queue**, not a **resumable upload
protocol**.

It recovers the operation after restarts. It does not resume from a byte
offset unless you add a protocol later (TUS, S3 multipart, chunked
upload). That is planned for 0.3.x.

Not included:

- S3 multipart / TUS / chunking
- Firebase Storage, Supabase Storage, Cloudinary, AWS SDK, Azure Blob, GCS
- GraphQL / WebSockets
- Complex native background upload services
- Encryption, image compression, video conversion, thumbnails
- Bidirectional synchronization
- Bundled UI
- Required Redux or Zustand
- Automatic auth token refresh (0.2.0)

409 Conflict is treated as a non-retryable validation failure. If your
API uses 409 differently, handle it in a custom transport/classifier
later.
