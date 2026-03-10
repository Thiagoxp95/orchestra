import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

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
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message || "Summarization failed" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
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
      const summary = await ctx.runAction(api.summarize.summarizeResponse, {
        response,
      });
      return new Response(JSON.stringify({ summary }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message || "Summarization failed" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }),
});

export default http;
