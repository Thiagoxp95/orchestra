import { describe, expect, it } from "bun:test";
import { buildQuery, parseIssues } from "./linear-up-next";

describe("buildQuery", () => {
  it("embeds the status name as a variable", () => {
    const body = JSON.parse(buildQuery("Up Next"));
    expect(body.variables).toEqual({ status: "Up Next" });
    expect(body.query).toContain("assignedIssues");
    expect(body.query).toContain("state: { name: { eqIgnoreCase: $status } }");
  });
});

describe("parseIssues", () => {
  it("flattens nested state into a list of issues", () => {
    const issues = parseIssues({
      data: {
        viewer: {
          assignedIssues: {
            nodes: [
              {
                identifier: "ENG-1",
                title: "Fix login",
                priorityLabel: "High",
                url: "https://linear.app/x/issue/ENG-1",
                state: { name: "Up Next" },
              },
            ],
          },
        },
      },
    });
    expect(issues).toEqual([
      {
        identifier: "ENG-1",
        title: "Fix login",
        priorityLabel: "High",
        url: "https://linear.app/x/issue/ENG-1",
        state: "Up Next",
      },
    ]);
  });

  it("returns an empty array when there are no issues", () => {
    expect(parseIssues({ data: { viewer: { assignedIssues: { nodes: [] } } } })).toEqual([]);
    expect(parseIssues({})).toEqual([]);
  });
});
