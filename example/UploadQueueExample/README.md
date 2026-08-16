# UploadQueueExample

A runnable Expo app whose job is to answer one question: **does this library
actually work on a device?**

Everything in the test suite runs in Node. Node cannot exercise the default
multipart body, because React Native's `FormData` keeps a `{ uri, name, type }`
object and its networking layer streams the file from that URI — there is no
equivalent anywhere else. This app deliberately uses that default path (it never
passes `buildBody`), on a real file-backed SQLite database, against the example
server.

## Setup

**1. Build and pack the library** from the repository root, so the app installs
the same artifact that would go to npm:

```bash
npm run build
npm pack
```

That writes `erickmorales91-react-native-upload-queue-0.1.0.tgz` at the root,
which this app's `package.json` already points at.

**2. Install the app:**

```bash
cd example/UploadQueueExample
npm install
npx expo install --fix   # reconciles the Expo SDK versions for your CLI
```

**3. Start the example server** in a second terminal:

```bash
cd example/server
node index.mjs
```

**4. Point the app at that server.** Edit `BASE_URL` at the top of `App.tsx`:

| Target | `BASE_URL` |
| --- | --- |
| iOS simulator | `http://localhost:8787` |
| Android emulator | `http://10.0.2.2:8787` |
| Physical device | `http://<your LAN IP>:8787` |

A physical device needs the LAN IP and the phone on the same network. Android
blocks cleartext HTTP on release builds; Expo Go in development allows it.

**5. Run it:**

```bash
npx expo start
```

## What to verify

Work down this list. Each line maps to a guarantee the README makes, and the
first four are the ones Node could never check.

- [ ] **The upload actually transfers.** Pick a photo. The server logs the
      request and reports a byte count matching the file — not a few dozen bytes.
      *This is the whole reason the app exists: it proves the React Native
      multipart part reaches the server as a file.*
- [ ] **Progress moves.** With slow mode on, the bar advances rather than jumping
      0 → 100.
- [ ] **SQLite persists.** Reload the app (`r` in the Expo CLI). The upload list
      comes back from disk with the same ids and statuses.
- [ ] **Recovery after a crash.** Start an upload in slow mode, then force-quit
      the app while it is `uploading`. Reopen it. Within ~10 seconds the row
      returns to `pending` and is retried. (`processingTimeoutMs` is lowered to
      10s in this app so you do not wait five minutes.)
- [ ] **Offline does not burn retries.** Enable airplane mode, enqueue an upload,
      wait, then note `attempts` stays at 0. Disable airplane mode: it uploads on
      its own, without you pressing anything.
- [ ] **Pause and cancel take effect mid-flight.** During a slow upload, press
      Pause. The status stays `paused` — it must not flip back to `pending` or
      `failed` on its own. Same for Cancel.
- [ ] **Retries respect the server.** Change the destination in `App.tsx` to
      `/uploads?fail=500` and watch attempts climb with a widening gap, then land
      on `failed`. With `/uploads?fail=429` the next attempt is about 5 seconds
      out, honouring `Retry-After` rather than the local backoff.
- [ ] **Concurrency is capped.** Enqueue four photos in slow mode. At most two
      are `uploading` at once.
- [ ] **Idempotency holds.** The server echoes the `Idempotency-Key`; it is the
      same across every attempt of a given upload.

## Notes

- The Expo SDK versions in `package.json` are a starting point. `npx expo install
  --fix` will align them with whatever CLI you have; that is expected and fine.
- The queue logs to the console (`[queue] …`), which is usually the fastest way
  to see why something is `blocked` or `failed`.
- This app is a diagnostic harness, not a product. It has no navigation, no
  error boundaries, and no design.
