# Remote image paste (phone → desktop agent)

Send a screenshot from the phone (Orchestra Web) into the Claude Code session
running on the desktop. Flow: phone clipboard/Photos → Convex file storage →
`sendImage` command → desktop bridge downloads to a temp file → types the path
into the session's PTY prompt (no Enter — the user keeps composing).

## Backend (`apps/backend/convex/remote.ts`, `schema.ts`)

- `generateUploadUrl` mutation (web-token gated): returns
  `ctx.storage.generateUploadUrl()`. First use of Convex file storage in the app.
- New `sendCommand` kind `"sendImage"`, payload `{ storageId, mime }`;
  `sessionId` = target session. Added to the `ptyCommands.kind` union in the
  schema too.
- `imageUrl` query (device-secret gated): `ctx.storage.getUrl(storageId)` for
  the bridge download.
- `deleteImage` mutation (device-secret gated): bridge deletes the blob after a
  successful download.
- Safety net: `pruneRemote` also deletes `_storage` files older than 10 minutes
  (covers commands pruned before the desktop consumed them, or a bridge that
  died mid-download).

## Web (`apps/web`)

- `ImagePasteButton` rendered inside `AgentKeyBar` (first row, end). Terminal
  passes `token`/`sessionId` down.
- Tap → `navigator.clipboard.read()` looking for an `image/*` item (iOS shows
  its "Paste" permission bubble). If the clipboard has no image or the API
  fails, fall back to a hidden `<input type="file" accept="image/*">` — the iOS
  photo picker, where screenshots land instantly.
- On image: POST blob to the upload URL → `sendCommand('sendImage')` with
  `{ storageId, mime }` for the attached session.
- Button states: idle → busy (spinner) → sent (check, 1.5s) / error (red flash).

## Desktop (`apps/desktop/src/main`)

- `remote-bridge-image.ts` — pure, Electron-free helpers (unit-tested):
  payload normalizer, mime → file extension, filename builder, stale-file
  selector; plus the fs download/prune wrappers.
- `remote-bridge.ts` `applyOne` gains `case 'sendImage'`: query `imageUrl`,
  fetch bytes, write `~/.orchestra/remote-images/remote-<ts>.<ext>`, then
  `daemon.write(sessionId, '<path> ')` — trailing space, no newline, so the
  user submits from the phone with their own text. Finally `deleteImage`.
- On bridge start: prune local images older than 24h.

## Error handling

- Bridge failures ride the existing `applyCommands` catch/log; the command is
  always deleted (existing `finally`), and the storage prune cleans the blob.
- Web surfaces upload/permission failures as the button's error state.

## Testing / rollout

- Unit tests for the pure helpers (mirrors `remote-bridge-*.test.ts` pattern).
- End-to-end verified on prod. Deploy order: backend (convex deploy) →
  desktop (build:install) → web (`vercel --prod --yes` from `apps/web`).
