# TODOs

## Webhook Event History Panel

**What:** UI panel showing recent webhook events (timestamp, payload preview, status).

**Why:** Debugging — when a webhook doesn't trigger, users need to see if the event arrived and what happened. Currently requires checking the Convex dashboard directly.

**Context:** The `webhookEvents` table already stores all events in Convex. This TODO is about adding a frontend panel to visualize them. The `AutomationRunsPanel` component provides a good pattern to follow — similar list view with status badges and timestamps. Start in `AddActionDialog.tsx` (inline in the webhook section) or as a standalone debug panel.

**Depends on:** Core webhook system (implemented).

## Webhook Payload Injection into Commands

**What:** Template variables like `{{payload.issue.title}}` in the action command, substituted with webhook payload data at execution time.

**Why:** Without this, the action command is static — it can't react to WHAT triggered it (e.g., which Linear issue was created). This limits webhooks to generic triggers rather than contextual automation.

**Context:** The webhook payload is already stored in `webhookEvents.payload` and passed through the processing pipeline. The injection point would be in `webhook-listener.ts` before calling `executeAutomation()` — the `action.command` string would be processed through a template engine. Key consideration: shell escaping is critical to prevent injection attacks. Use `JSON.stringify()` to safely escape values before substitution. Start with simple dot-notation paths like `{{payload.data.title}}`.

**Depends on:** Core webhook system (implemented).
