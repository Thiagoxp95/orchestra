# Reliable native chat session control

Implemented and validated on `refactor/chat-session-control`, 2026-09-10–11. The user subsequently authorized production rollout as v1.22.0.

## User decision and scope

The user explicitly approved: **“Yes — prioritize reliable native chat.”** Orchestra owns Claude and Codex conversations through structured provider APIs. Terminal is an independent shell for these sessions.

Standard interactive Claude/Codex launches use native ownership. Existing CLI conversations have an explicit **Use native chat** handoff that checks the exact provider and conversation ID, terminates the previous owner, and resumes that conversation. Custom scripts, print modes, subcommands and unsupported CLI arguments retain their existing semantics.

## Reference and reuse

Studied [t3code](https://github.com/pingdotgg/t3code) at commit `c52b8d96e4b34201f19b5e5bb12c6b2a77bfaa9a`, checked out at `/tmp/orchestra-t3code-reference`.

- `docs/internals/overview.md`: host execution ownership, durable intent, shared client state.
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`: app-server thread and turn methods, model/effort on real turns, active-turn interruption, compaction.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`: SDK stream ownership and native controls. Adapted implementation retains the full MIT notice, copyright 2026 T3 Tools Inc., in Orchestra's Claude adapter.

The implementation uses the installed Codex 0.154.0 app-server protocol and pinned `@anthropic-ai/claude-agent-sdk` 0.3.260. The installed Claude CLI was 2.1.268.

## Delivered architecture

- **Shared protocol:** typed commands, requests, replies, snapshots, catalogs and normalized status in `apps/desktop/src/shared/native-chat*.ts`.
- **Provider adapters:** Claude SDK and Codex app-server adapters under `apps/desktop/src/main/native-chat/`. They own streaming, initialization, resume history, send, model/effort, images, approval/questions, Stop and compaction.
- **Durable host manager:** persists conversation identity, accepted settings, bounded history and command receipts. Serializes session input while allowing Stop out of band. Retired connections cannot publish stale events or overlap replacement owners.
- **Atomic storage:** per-session files separate from renderer workspace saves. Incomplete temporary writes are ignored; corrupt committed records fail explicitly. Receipts are written before effects, retained across restarts and checked before downloads or cancellation side effects. Uncertain crash outcomes require inspection rather than automatic replay.
- **Remote command protocol:** Convex pending commands and accepted/failed receipts distinguish queueing from host acceptance. Stop cancels queued input transactionally and takes priority. Reloaded web panes observe pending commands; receipt timeouts retain the send gate while the outcome remains unknown.
- **Authoritative settings:** pickers use provider model IDs and supported effort catalogs. Changes display only after host acceptance. Codex pins an advertised default model rather than inheriting an unavailable local CLI default. Actual turns receive the accepted settings.
- **Feed and persistence:** stable message UIDs, immutable row updates, coalesced changed-row publishing, 400-row retained windows and generation guards prevent stale fetches from replacing newer messages. Native remote history is exempt from the legacy TTL through a separate index, so retained native rows cannot starve legacy cleanup.
- **Session UI:** desktop and web native send/steer/configure/compact/Stop and request cards. Drafts, attachments, optimistic echoes and pending gates belong to sessions and survive pane remounts. Draft revisions protect edits made while a send is awaiting acceptance.
- **Separate shell lifecycle:** native state determines chat activity, provider identity and settings; shell process status cannot overwrite it. Closing the pane cancels migration and closes the provider. App shutdown waits for bounded provider cleanup and flushes durable state.

## Legacy hardening retained

Existing custom CLI sessions use the cancellable `ChatInputController`, shared desktop/remote serialization, out-of-band remote Stop and guarded image/question routing. These sessions still use CLI keystrokes until handed off; native sessions do not fall back to terminal automation.

Feed generation and immutable merge fixes apply to both session types. Legacy model overrides are isolated from native authoritative settings. Native `/clear` reports that a new session is required instead of pretending the conversation was cleared.

## Regression coverage and review

Tests exercise settings persistence/rejection/rollback, resumed identity, overlapping turn rejection, compact→Stop→send, durable receipt replay beyond 100 commands, uncertain crash outcomes, stale requests, retired-owner events, migration cancellation across daemon awaits, provider pairing, recursive hydration, image-upload cancellation and replayed Stop isolation.

Adapter tests exercise actual protocol-shaped streams, model catalogs, provider errors, images, requests, resume history, pending-start cancellation and post-interrupt recovery. UI tests cover provider picker IDs, typed slash controls, stale snapshots, draft revision ordering and receipt watchers that outlive pane unmounts. Storage tests cover replacement, file permissions, interrupted writes and corrupt records. Backend tests exercise transactional Stop and remote path rejection, plus native history retention beyond a cleanup page.

Independent implementation review found and drove fixes for migration races, provider pairing, cold hydration recursion, receipt eviction, unawaited shutdown, pending Codex startup cancellation, picker values, delayed legacy feed overwrites and Stop replay cancellation.

## Live checks observed

Only fresh test conversations in temporary working directories were used; no existing user conversation was migrated or interrupted.

- Claude: real no-prompt initialization emitted the model catalog; a fresh Haiku/low turn returned the requested `OK`; no-prompt interruption completed.
- Codex: real catalog initialization, a fresh explicitly listed `gpt-5.6-luna`/low turn, compaction followed by Stop and idle, then another send reconnecting/resuming the same thread and returning `OK`.
- The live Codex check exposed an unavailable machine-default model; the adapter now resolves omitted models from its advertised catalog and persists the choice. A protocol regression test verifies the fix; no additional paid turn was run for that change.

Live approval/question interactions, a real existing-conversation handoff, and installed-app desktop/web interaction were not exercised. Their automated coverage is not a claim of manual end-to-end QA.

## Final validation

After the final migration Stop UI fix:

- Desktop: 134 test files, **1,486 tests passed** (`vitest run --maxWorkers=4`).
- Web: 27 test files, **426 tests passed** (`bun run test`).
- Backend: 7 test files, **41 tests passed** (`bun test convex`).
- Workspace typecheck: **3 successful / 3 total**.
- Workspace lint: **706 warnings, 0 errors**. Existing warning debt remains.
- Desktop and web production builds passed.
- `git diff --check` passed.

No measured bundle-size improvement or exhaustive performance audit is claimed. Existing large renderer assets remain outside this session-control refactor.

## Rollout

The user authorized the full release on 2026-09-11. A production Convex snapshot was exported before deploying the schema, indexes and functions. Authenticated native pending-command reads and unauthenticated session-read rejection were verified on the production backend.

The Vercel project now builds from the repository root with `apps/web` as its Root Directory, so shared protocol imports and Bun dependencies are available. Deployment commands are recorded in `apps/web/README.md`.

Desktop v1.22.0 uses the repository's signed/notarized GitHub release workflow. Packaged-runtime verification exposed the Claude SDK resolving its executable inside `app.asar`; the executable must instead be launched from electron-builder's unpacked location. This release includes that correction.

The new command protocol and native snapshots require updated desktop and web clients; an old web client cannot control a native conversation through legacy keystrokes. Published assets and the release's final status are recorded on GitHub.
