#!/usr/bin/env bun
/**
 * Print Linear issues assigned to the authenticated user that are in a given
 * workflow state (default: "Up Next") as a JSON array.
 *
 * Usage:
 *   LINEAR_API_KEY=lin_api_... bun run scripts/linear-up-next.ts ["Status Name"]
 */

const LINEAR_API_URL = "https://api.linear.app/graphql";
const DEFAULT_STATUS = "Up Next";

export interface LinearIssue {
  identifier: string;
  title: string;
  priorityLabel: string;
  url: string;
  state: string;
}

/** Build the GraphQL request body for the assigned-issues query. Pure, testable. */
export function buildQuery(statusName: string): string {
  return JSON.stringify({
    query: `
      query AssignedIssues($status: String!) {
        viewer {
          assignedIssues(filter: { state: { name: { eqIgnoreCase: $status } } }, first: 50) {
            nodes {
              identifier
              title
              priorityLabel
              url
              state { name }
            }
          }
        }
      }
    `,
    variables: { status: statusName },
  });
}

interface GraphQLNode {
  identifier: string;
  title: string;
  priorityLabel: string;
  url: string;
  state: { name: string };
}

interface GraphQLResponse {
  data?: { viewer?: { assignedIssues?: { nodes?: GraphQLNode[] } } };
  errors?: { message: string }[];
}

/** Normalize the GraphQL response into a flat list of issues. Pure, testable. */
export function parseIssues(body: GraphQLResponse): LinearIssue[] {
  const nodes = body.data?.viewer?.assignedIssues?.nodes ?? [];
  return nodes.map((n) => ({
    identifier: n.identifier,
    title: n.title,
    priorityLabel: n.priorityLabel,
    url: n.url,
    state: n.state.name,
  }));
}

export async function fetchIssues(apiKey: string, statusName: string): Promise<LinearIssue[]> {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: buildQuery(statusName),
  });

  if (!res.ok) {
    throw new Error(`Linear API returned HTTP ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as GraphQLResponse;
  if (body.errors?.length) {
    throw new Error(`Linear API error: ${body.errors.map((e) => e.message).join("; ")}`);
  }

  return parseIssues(body);
}

async function main(): Promise<void> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error("Error: LINEAR_API_KEY environment variable is not set.");
    process.exit(1);
  }

  const statusName = process.argv[2] ?? DEFAULT_STATUS;

  try {
    const issues = await fetchIssues(apiKey, statusName);
    console.log(JSON.stringify(issues, null, 2));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Only run when executed directly, not when imported by tests.
if (import.meta.main) {
  void main();
}
