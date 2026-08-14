# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

Please open a private security advisory on GitHub or contact the maintainer.
Do not include secrets, tokens, or private production data in public issues.

## Notes

This library never stores access tokens, refresh tokens, Authorization headers,
cookies, or passwords inside upload records. Tokens must be supplied on every
attempt through `getAccessToken`.

Do not persist the multipart body. Store file URIs, small metadata, and the
destination path only. Avoid logging full `UploadTask` objects: they may contain
private file paths or metadata.
