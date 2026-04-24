declare const _default: import("convex/server").SchemaDefinition<{
    webhooks: import("convex/server").TableDefinition<import("convex/values").VObject<{
        filter?: string | undefined;
        name: string;
        createdAt: number;
        workspaceId: string;
        actionId: string;
        enabled: boolean;
        token: string;
    }, {
        token: import("convex/values").VString<string, "required">;
        workspaceId: import("convex/values").VString<string, "required">;
        actionId: import("convex/values").VString<string, "required">;
        name: import("convex/values").VString<string, "required">;
        enabled: import("convex/values").VBoolean<boolean, "required">;
        filter: import("convex/values").VString<string | undefined, "optional">;
        createdAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "filter" | "name" | "createdAt" | "workspaceId" | "actionId" | "enabled" | "token">, {
        by_token: ["token", "_creationTime"];
    }, {}, {}>;
    webhookEvents: import("convex/server").TableDefinition<import("convex/values").VObject<{
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
    }, {
        webhookId: import("convex/values").VId<import("convex/values").GenericId<"webhooks">, "required">;
        token: import("convex/values").VString<string, "required">;
        workspaceId: import("convex/values").VString<string, "required">;
        actionId: import("convex/values").VString<string, "required">;
        payload: import("convex/values").VAny<any, "required", string>;
        status: import("convex/values").VUnion<"pending" | "filtered" | "processing" | "completed" | "failed" | "expired", [import("convex/values").VLiteral<"pending", "required">, import("convex/values").VLiteral<"processing", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"expired", "required">, import("convex/values").VLiteral<"filtered", "required">], "required", never>;
        filterResult: import("convex/values").VString<string | undefined, "optional">;
        filterPrompt: import("convex/values").VString<string | undefined, "optional">;
        createdAt: import("convex/values").VFloat64<number, "required">;
        processedAt: import("convex/values").VFloat64<number | undefined, "optional">;
    }, "required", "createdAt" | "workspaceId" | "actionId" | "status" | "token" | "webhookId" | "payload" | "filterResult" | "filterPrompt" | "processedAt" | `payload.${string}`>, {
        by_status: ["status", "_creationTime"];
        by_created: ["createdAt", "_creationTime"];
    }, {}, {}>;
    issueLabels: import("convex/server").TableDefinition<import("convex/values").VObject<{
        name: string;
        color: string;
        workspaceId: string;
    }, {
        workspaceId: import("convex/values").VString<string, "required">;
        name: import("convex/values").VString<string, "required">;
        color: import("convex/values").VString<string, "required">;
    }, "required", "name" | "color" | "workspaceId">, {
        by_workspace: ["workspaceId", "_creationTime"];
    }, {}, {}>;
    issues: import("convex/server").TableDefinition<import("convex/values").VObject<{
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
    }, {
        workspaceId: import("convex/values").VString<string, "required">;
        identifier: import("convex/values").VString<string, "required">;
        title: import("convex/values").VString<string, "required">;
        description: import("convex/values").VString<string | undefined, "optional">;
        status: import("convex/values").VUnion<"shaping" | "todo" | "in_progress" | "in_review" | "done", [import("convex/values").VLiteral<"shaping", "required">, import("convex/values").VLiteral<"todo", "required">, import("convex/values").VLiteral<"in_progress", "required">, import("convex/values").VLiteral<"in_review", "required">, import("convex/values").VLiteral<"done", "required">], "required", never>;
        priority: import("convex/values").VFloat64<number, "required">;
        assigneeName: import("convex/values").VString<string | undefined, "optional">;
        assigneeAvatarUrl: import("convex/values").VString<string | undefined, "optional">;
        labelIds: import("convex/values").VArray<import("convex/values").GenericId<"issueLabels">[], import("convex/values").VId<import("convex/values").GenericId<"issueLabels">, "required">, "required">;
        linearId: import("convex/values").VString<string | undefined, "optional">;
        linearIdentifier: import("convex/values").VString<string | undefined, "optional">;
        linearUrl: import("convex/values").VString<string | undefined, "optional">;
        position: import("convex/values").VFloat64<number, "required">;
        createdAt: import("convex/values").VFloat64<number, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "createdAt" | "workspaceId" | "title" | "position" | "labelIds" | "description" | "status" | "identifier" | "priority" | "assigneeName" | "assigneeAvatarUrl" | "linearId" | "linearIdentifier" | "linearUrl" | "updatedAt">, {
        by_workspace: ["workspaceId", "_creationTime"];
        by_linearId: ["linearId", "_creationTime"];
    }, {}, {}>;
}, true>;
export default _default;
