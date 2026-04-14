"use node";
import { action } from "./_generated/server";
import { v } from "convex/values";

// No heuristic fallback. If the LLM fails to return a `requiresUserInput`
// field we default to `false` — a missed promotion to `waitingUserInput`
// is strictly better than a false one (which used to flag every joke
// containing a setup-question with a "?" in it).
function inferRequiresUserInput(_response: string): boolean {
  return false;
}

function parseResponsePayload(
  raw: string,
  fallbackSource: string
): { title: string; summary: string; requiresUserInput: boolean } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      const title =
        typeof parsed.title === "string" ? parsed.title.trim() : "";
      const summary =
        typeof parsed.summary === "string" ? parsed.summary.trim() : "";

      if (summary) {
        return {
          title: title || summary.split(/[.!?]/)[0].trim().slice(0, 50),
          summary,
          requiresUserInput:
            typeof parsed.requiresUserInput === "boolean"
              ? parsed.requiresUserInput
              : inferRequiresUserInput(fallbackSource),
        };
      }
    } catch {
      // Fall through to the heuristic fallback below.
    }
  }

  return {
    title: "Agent finished work",
    summary: raw.trim().replace(/^["']|["']$/g, "") || "Agent finished work.",
    requiresUserInput: inferRequiresUserInput(fallbackSource),
  };
}

export const summarizePrompt = action({
  args: {
    prompt: v.string(),
  },
  handler: async (_ctx, { prompt }): Promise<string> => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY not configured");
    }

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
            content:
              "You are a label generator. Given a user prompt sent to a coding AI assistant, respond with ONLY a 3-4 word summary that describes what the user wants. No punctuation, no quotes. Examples: 'Fix sidebar spacing', 'Add dark mode', 'Refactor auth logic', 'Debug API timeout'.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: 20,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      throw new Error("No summary returned from LLM");
    }

    return summary;
  },
});

export const summarizeResponse = action({
  args: {
    response: v.string(),
  },
  handler: async (
    _ctx,
    { response }
  ): Promise<{ title: string; summary: string; requiresUserInput: boolean }> => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY not configured");
    }

    // Truncate very long responses to save tokens
    const truncated = response.length > 2000 ? response.slice(-2000) : response;

    const fetchResponse = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          // gemini-2.5-flash: fast (~sub-second) and plenty capable for this
          // classification + short summary task. gpt-5 was adding multi-second
          // latency between `Stop` and the sidebar's attention badge, which
          // read as "Orchestra missed the question" even though it hadn't.
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content:
                'You summarize coding AI assistant responses for desktop notifications. CRITICAL RULES: 1) ONLY describe what is EXPLICITLY written in the provided text. NEVER invent, assume, or fabricate actions or content not present. 2) If the text is just a question, summarize the question itself. 3) If the text is short or simple, keep the summary equally short. Respond with ONLY minified JSON: {"title":"...","summary":"...","requiresUserInput":true/false}. `title`: 3-5 word label of what the text actually says (e.g. "Ask about next task", "Fixed sidebar spacing", "Request clarification"). `summary`: 1-2 sentences describing ONLY what the text contains. `requiresUserInput`: true if the text asks the user a question, requests input, or invites a response. No markdown, no extra text.',
            },
            {
              role: "user",
              content: truncated,
            },
          ],
          max_tokens: 220,
          temperature: 0.2,
        }),
      }
    );

    if (!fetchResponse.ok) {
      const text = await fetchResponse.text();
      throw new Error(`OpenRouter API error: ${fetchResponse.status} ${text}`);
    }

    const data = await fetchResponse.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) {
      throw new Error("No summary returned from LLM");
    }

    return parseResponsePayload(raw, truncated);
  },
});
