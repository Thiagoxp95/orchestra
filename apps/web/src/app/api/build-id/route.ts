// Answers with the build id baked into this deployment (see next.config.ts).
// A running page fetches this to learn whether a newer deployment is live at
// the same origin. no-store: the browser must never satisfy the check from its
// own HTTP cache — that would always echo the stale page's own build.
export function GET(): Response {
  return new Response(process.env.NEXT_PUBLIC_BUILD_ID ?? "dev", {
    headers: { "cache-control": "no-store" },
  });
}
