/** Evaluate a webhook payload against a plain-English filter condition using a cheap LLM. */
export declare const evaluateFilter: import("convex/server").RegisteredAction<"public", {
    filter: string;
    payload: any;
}, Promise<{
    pass: boolean;
    reason: string;
}>>;
