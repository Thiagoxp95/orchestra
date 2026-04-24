export declare const summarizePrompt: import("convex/server").RegisteredAction<"public", {
    prompt: string;
}, Promise<string>>;
export declare const summarizeResponse: import("convex/server").RegisteredAction<"public", {
    response: string;
}, Promise<{
    title: string;
    summary: string;
    requiresUserInput: boolean;
}>>;
