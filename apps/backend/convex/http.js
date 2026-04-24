import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
const http = httpRouter();
http.route({
    path: "/api/summarize",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
        const body = await request.json();
        const { prompt } = body;
        if (!prompt || typeof prompt !== "string") {
            return new Response(JSON.stringify({ error: "Missing prompt" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }
        try {
            const summary = await ctx.runAction(api.summarize.summarizePrompt, {
                prompt,
            });
            return new Response(JSON.stringify({ summary }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        catch (err) {
            return new Response(JSON.stringify({ error: err.message || "Summarization failed" }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    }),
});
http.route({
    path: "/api/summarize-response",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
        const body = await request.json();
        const { response } = body;
        if (!response || typeof response !== "string") {
            return new Response(JSON.stringify({ error: "Missing response" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }
        try {
            const result = await ctx.runAction(api.summarize.summarizeResponse, {
                response,
            });
            return new Response(JSON.stringify(result), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        catch (err) {
            return new Response(JSON.stringify({ error: err.message || "Summarization failed" }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    }),
});
// ── Webhook receiver ─────────────────────────────────────────────────
// External services (Linear, GitHub, etc.) POST here to trigger actions.
//
//  Linear POST ──▶ /webhook/{token}
//       │
//       ├── token not found ──▶ 404
//       ├── webhook disabled ──▶ 403
//       └── valid ──▶ store event (pending) ──▶ 200
//
http.route({
    pathPrefix: "/webhook/",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
        const url = new URL(request.url);
        const token = url.pathname.replace(/^\/webhook\//, "");
        if (!token) {
            return new Response(JSON.stringify({ error: "Missing token" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }
        // Look up webhook by token
        const webhook = await ctx.runQuery(internal.webhooks.getByToken, { token });
        if (!webhook) {
            return new Response(JSON.stringify({ error: "Webhook not found" }), {
                status: 404,
                headers: { "Content-Type": "application/json" },
            });
        }
        if (!webhook.enabled) {
            return new Response(JSON.stringify({ error: "Webhook disabled" }), {
                status: 403,
                headers: { "Content-Type": "application/json" },
            });
        }
        // Parse payload — accept JSON or raw text
        let payload = null;
        try {
            payload = await request.json();
        }
        catch {
            try {
                payload = { raw: await request.text() };
            }
            catch {
                payload = null;
            }
        }
        // If the webhook has a filter, evaluate it with the LLM
        if (webhook.filter) {
            const filterResult = await ctx.runAction(api.webhookFilter.evaluateFilter, {
                filter: webhook.filter,
                payload,
            });
            if (!filterResult.pass) {
                // Path 1 — Filter rejects: store as filtered for auditability
                await ctx.runMutation(internal.webhooks.createEvent, {
                    webhookId: webhook._id,
                    token,
                    workspaceId: webhook.workspaceId,
                    actionId: webhook.actionId,
                    payload,
                    filterPrompt: webhook.filter,
                    filterResult: filterResult.reason,
                    filtered: true,
                });
                return new Response(JSON.stringify({ ok: false, filtered: true, reason: filterResult.reason }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }
            // Path 2 — Filter passes: store with filter context for observability
            await ctx.runMutation(internal.webhooks.createEvent, {
                webhookId: webhook._id,
                token,
                workspaceId: webhook.workspaceId,
                actionId: webhook.actionId,
                payload,
                filterPrompt: webhook.filter,
                filterResult: filterResult.reason,
            });
        }
        else {
            // Path 3 — No filter: bare event
            await ctx.runMutation(internal.webhooks.createEvent, {
                webhookId: webhook._id,
                token,
                workspaceId: webhook.workspaceId,
                actionId: webhook.actionId,
                payload,
            });
        }
        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }),
});
export default http;
