/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as dictationLogic from "../dictationLogic.js";
import type * as http from "../http.js";
import type * as issueLabels from "../issueLabels.js";
import type * as issues from "../issues.js";
import type * as push from "../push.js";
import type * as remote from "../remote.js";
import type * as remoteAuth from "../remoteAuth.js";
import type * as remoteDictation from "../remoteDictation.js";
import type * as sendPush from "../sendPush.js";
import type * as summarize from "../summarize.js";
import type * as ticketDrafts from "../ticketDrafts.js";
import type * as webhookFilter from "../webhookFilter.js";
import type * as webhooks from "../webhooks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  dictationLogic: typeof dictationLogic;
  http: typeof http;
  issueLabels: typeof issueLabels;
  issues: typeof issues;
  push: typeof push;
  remote: typeof remote;
  remoteAuth: typeof remoteAuth;
  remoteDictation: typeof remoteDictation;
  sendPush: typeof sendPush;
  summarize: typeof summarize;
  ticketDrafts: typeof ticketDrafts;
  webhookFilter: typeof webhookFilter;
  webhooks: typeof webhooks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
