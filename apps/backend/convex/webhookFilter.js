"use node";
import { action } from "./_generated/server";
import { v } from "convex/values";
/** Evaluate a webhook payload against a plain-English filter condition using a cheap LLM. */
export const evaluateFilter = action({
    args: {
        filter: v.string(),
        payload: v.any(),
    },
    handler: async (_ctx, { filter, payload }) => {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            // If no API key, let everything through
            return { pass: true, reason: "No OPENROUTER_API_KEY configured — skipping filter" };
        }
        const payloadStr = typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2);
        // Truncate very large payloads to save tokens
        const truncated = payloadStr.length > 4000
            ? payloadStr.slice(0, 4000) + "\n... (truncated)"
            : payloadStr;
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: "google/gemini-2.0-flash-001",
                messages: [
                    {
                        role: "system",
                        content: `You are a webhook payload filter. The user has defined a condition in plain English. ` +
                            `You must decide whether the given JSON payload matches that condition.\n\n` +
                            `Respond with ONLY minified JSON: {"pass":true/false,"reason":"..."}\n` +
                            `- "pass": true if the payload matches the condition, false if it does not.\n` +
                            `- "reason": a brief one-sentence explanation of why it matched or didn't.\n\n` +
                            `No markdown, no extra text. JSON only.`,
                    },
                    {
                        role: "user",
                        content: `CONDITION: ${filter}\n\n` +
                            `PAYLOAD:\n${truncated}`,
                    },
                ],
                max_tokens: 100,
                temperature: 0,
            }),
        });
        if (!response.ok) {
            const text = await response.text();
            console.error(`[evaluateFilter] OpenRouter API error: ${response.status} ${text}`);
            // On API failure, let the event through (fail open)
            return { pass: true, reason: `Filter evaluation failed: ${response.status}` };
        }
        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content?.trim();
        if (!raw) {
            return { pass: true, reason: "No response from LLM — allowing event" };
        }
        // Parse the JSON response
        try {
            const start = raw.indexOf("{");
            const end = raw.lastIndexOf("}");
            if (start >= 0 && end > start) {
                const parsed = JSON.parse(raw.slice(start, end + 1));
                return {
                    pass: typeof parsed.pass === "boolean" ? parsed.pass : true,
                    reason: typeof parsed.reason === "string" ? parsed.reason : raw,
                };
            }
        }
        catch {
            // Fall through
        }
        // If we can't parse, look for clear pass/fail signals
        const lower = raw.toLowerCase();
        if (lower.includes('"pass":false') || lower.includes('"pass": false')) {
            return { pass: false, reason: raw };
        }
        return { pass: true, reason: raw };
    },
});
