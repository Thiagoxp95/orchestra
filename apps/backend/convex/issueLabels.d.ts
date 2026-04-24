export declare const listByWorkspace: import("convex/server").RegisteredQuery<"public", {
    workspaceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"issueLabels">;
    _creationTime: number;
    name: string;
    color: string;
    workspaceId: string;
}[]>>;
export declare const create: import("convex/server").RegisteredMutation<"public", {
    name: string;
    color: string;
    workspaceId: string;
}, Promise<import("convex/values").GenericId<"issueLabels">>>;
export declare const findOrCreateByName: import("convex/server").RegisteredMutation<"public", {
    name: string;
    color: string;
    workspaceId: string;
}, Promise<import("convex/values").GenericId<"issueLabels">>>;
