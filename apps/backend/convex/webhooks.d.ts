/** Look up a webhook by its URL token. Internal — only http.ts calls this. */
export declare const getByToken: import("convex/server").RegisteredQuery<"internal", {
    token: string;
}, Promise<{
    _id: import("convex/values").GenericId<"webhooks">;
    _creationTime: number;
    filter?: string | undefined;
    name: string;
    createdAt: number;
    workspaceId: string;
    actionId: string;
    enabled: boolean;
    token: string;
} | null>>;
export declare const getPendingEvents: import("convex/server").RegisteredQuery<"public", {}, Promise<{
    _id: import("convex/values").GenericId<"webhookEvents">;
    _creationTime: number;
    filterResult?: string | undefined;
    filterPrompt?: string | undefined;
    processedAt?: number | undefined;
    createdAt: number;
    workspaceId: string;
    actionId: string;
    status: "pending" | "filtered" | "processing" | "completed" | "failed" | "expired";
    token: string;
    webhookId: import("convex/values").GenericId<"webhooks">;
    payload: any;
}[]>>;
export declare const getRecentEventNotifications: import("convex/server").RegisteredQuery<"public", {
    since: number;
}, Promise<{
    _id: import("convex/values").GenericId<"webhookEvents">;
    _creationTime: number;
    filterResult?: string | undefined;
    filterPrompt?: string | undefined;
    processedAt?: number | undefined;
    createdAt: number;
    workspaceId: string;
    actionId: string;
    status: "pending" | "filtered" | "processing" | "completed" | "failed" | "expired";
    token: string;
    webhookId: import("convex/values").GenericId<"webhooks">;
    payload: any;
}[]>>;
export declare const create: import("convex/server").RegisteredMutation<"public", {
    filter?: string | undefined;
    name: string;
    workspaceId: string;
    actionId: string;
    token: string;
}, Promise<import("convex/values").GenericId<"webhooks">>>;
export declare const updateFilter: import("convex/server").RegisteredMutation<"public", {
    filter?: string | undefined;
    token: string;
}, Promise<void>>;
export declare const remove: import("convex/server").RegisteredMutation<"public", {
    token: string;
}, Promise<void>>;
/** Store an incoming webhook payload. Internal — only http.ts calls this. */
export declare const createEvent: import("convex/server").RegisteredMutation<"internal", {
    filtered?: boolean | undefined;
    filterResult?: string | undefined;
    filterPrompt?: string | undefined;
    workspaceId: string;
    actionId: string;
    token: string;
    webhookId: import("convex/values").GenericId<"webhooks">;
    payload: any;
}, Promise<import("convex/values").GenericId<"webhookEvents">>>;
/** Atomically claim a pending event. Returns event data if claimed, null if already taken. */
export declare const claimEvent: import("convex/server").RegisteredMutation<"public", {
    eventId: import("convex/values").GenericId<"webhookEvents">;
}, Promise<{
    _id: import("convex/values").GenericId<"webhookEvents">;
    _creationTime: number;
    filterResult?: string | undefined;
    filterPrompt?: string | undefined;
    processedAt?: number | undefined;
    createdAt: number;
    workspaceId: string;
    actionId: string;
    status: "pending" | "filtered" | "processing" | "completed" | "failed" | "expired";
    token: string;
    webhookId: import("convex/values").GenericId<"webhooks">;
    payload: any;
} | null>>;
export declare const completeEvent: import("convex/server").RegisteredMutation<"public", {
    status: "completed" | "failed" | "expired";
    eventId: import("convex/values").GenericId<"webhookEvents">;
}, Promise<void>>;
/** Delete webhook events older than 7 days. */
export declare const cleanupOldEvents: import("convex/server").RegisteredMutation<"internal", {}, Promise<{
    deleted: number;
}>>;
