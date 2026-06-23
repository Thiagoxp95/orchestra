// Pure helpers for web-push fan-out. No Convex/Node imports here so they can be
// unit-tested with bun:test (the backend has no convex-test harness).

export interface PushNotificationInput {
  title: string;
  body: string;
  sessionId: string;
  requiresUserInput: boolean;
}

/** JSON payload delivered to the service worker's `push` handler. */
export function buildPushPayload(input: PushNotificationInput): string {
  return JSON.stringify({
    title: input.title,
    body: input.body,
    sessionId: input.sessionId,
    requiresUserInput: input.requiresUserInput,
  });
}

/** Push services return 404/410 for subscriptions that should be pruned. */
export function isExpiredPushError(statusCode: number): boolean {
  return statusCode === 404 || statusCode === 410;
}
