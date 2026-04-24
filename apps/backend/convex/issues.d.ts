export declare const listByWorkspace: import("convex/server").RegisteredQuery<"public", {
    workspaceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"issues">;
    _creationTime: number;
    description?: string | undefined;
    assigneeName?: string | undefined;
    assigneeAvatarUrl?: string | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    createdAt: number;
    workspaceId: string;
    title: string;
    position: number;
    labelIds: import("convex/values").GenericId<"issueLabels">[];
    status: "shaping" | "todo" | "in_progress" | "in_review" | "done";
    identifier: string;
    priority: number;
    updatedAt: number;
}[]>>;
export declare const getById: import("convex/server").RegisteredQuery<"public", {
    id: import("convex/values").GenericId<"issues">;
}, Promise<{
    _id: import("convex/values").GenericId<"issues">;
    _creationTime: number;
    description?: string | undefined;
    assigneeName?: string | undefined;
    assigneeAvatarUrl?: string | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    createdAt: number;
    workspaceId: string;
    title: string;
    position: number;
    labelIds: import("convex/values").GenericId<"issueLabels">[];
    status: "shaping" | "todo" | "in_progress" | "in_review" | "done";
    identifier: string;
    priority: number;
    updatedAt: number;
} | null>>;
export declare const create: import("convex/server").RegisteredMutation<"public", {
    description?: string | undefined;
    assigneeName?: string | undefined;
    workspaceId: string;
    title: string;
    position: number;
    labelIds: import("convex/values").GenericId<"issueLabels">[];
    status: "shaping" | "todo" | "in_progress" | "in_review" | "done";
    priority: number;
}, Promise<import("convex/values").GenericId<"issues">>>;
export declare const update: import("convex/server").RegisteredMutation<"public", {
    title?: string | undefined;
    position?: number | undefined;
    labelIds?: import("convex/values").GenericId<"issueLabels">[] | undefined;
    description?: string | undefined;
    status?: "todo" | "in_progress" | "in_review" | "done" | undefined;
    priority?: number | undefined;
    assigneeName?: string | undefined;
    assigneeAvatarUrl?: string | undefined;
    id: import("convex/values").GenericId<"issues">;
}, Promise<void>>;
export declare const updateStatus: import("convex/server").RegisteredMutation<"public", {
    id: import("convex/values").GenericId<"issues">;
    position: number;
    status: "shaping" | "todo" | "in_progress" | "in_review" | "done";
}, Promise<void>>;
export declare const remove: import("convex/server").RegisteredMutation<"public", {
    id: import("convex/values").GenericId<"issues">;
}, Promise<void>>;
export declare const upsertFromLinear: import("convex/server").RegisteredMutation<"public", {
    description?: string | undefined;
    assigneeName?: string | undefined;
    assigneeAvatarUrl?: string | undefined;
    workspaceId: string;
    title: string;
    labelIds: import("convex/values").GenericId<"issueLabels">[];
    priority: number;
    linearId: string;
    linearIdentifier: string;
    linearUrl: string;
    mappedStatus: "shaping" | "todo" | "in_progress" | "in_review" | "done";
}, Promise<{
    id: import("convex/values").GenericId<"issues">;
    created: boolean;
}>>;
