"use node";
import { action } from "./_generated/server";
import { v } from "convex/values";

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
