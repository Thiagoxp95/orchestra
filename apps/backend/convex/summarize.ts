"use node";
import { action } from "./_generated/server";
import { v } from "convex/values";

function inferRequiresUserInput(response: string): boolean {
  const normalized = response.replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  if (normalized.includes("?")) return true;

  return [
    "do you want",
    "would you like",
    "can you",
    "could you",
    "should i",
    "which option",
    "what would you like",
    "please confirm",
    "let me know",
    "need your input",
    "can i continue",
    "can i proceed",
    "please provide",
    "please choose",
  ].some((phrase) => lower.includes(phrase));
}

function parseResponsePayload(
  raw: string,
  fallbackSource: string
): { summary: string; requiresUserInput: boolean } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      const summary =
        typeof parsed.summary === "string" ? parsed.summary.trim() : "";

      if (summary) {
        return {
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
        model: "meta-llama/llama-4-scout",
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
  ): Promise<{ summary: string; requiresUserInput: boolean }> => {
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
          model: "meta-llama/llama-4-scout",
          messages: [
            {
              role: "system",
              content:
                'You are a summarizer. Given the final response from a coding AI assistant, respond with ONLY minified JSON using this exact shape: {"summary":"...","requiresUserInput":true}. `summary` must be 1-2 concise sentences describing what the assistant did, concluded, or asked. `requiresUserInput` must be true only when the assistant explicitly asks the user a question, requests approval, or needs additional information before proceeding. No markdown fences, no extra text.',
            },
            {
              role: "user",
              content: truncated,
            },
          ],
          max_tokens: 140,
          temperature: 0.3,
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
