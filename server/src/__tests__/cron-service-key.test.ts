import { describe, expect, it } from "vitest";
import { agentApiKeyScopeSchema, type CronServiceAgentKeyScope } from "@paperclipai/shared";
import { cronServiceRequestAllowed } from "../middleware/cron-service-key.js";

const companyId = "ac917a45-e6ea-4696-a85c-991147084939";
const agentId = "94906724-4190-4b53-9393-66148d453477";
const issueId = "7f82bd2d-f408-4e8f-98aa-d54b5a58903b";
const otherIssueId = "ff5e9a5f-b6cc-4c34-8958-0bd8e31ccd7c";
const projectId = "889a9edc-6a07-406d-a7ca-dcb1b4de1de3";
const pixelAgentId = "f0ddf9c0-d0cf-4a44-8b0b-c2167232852e";

function request(
  scope: CronServiceAgentKeyScope,
  method: string,
  path: string,
  body: unknown = undefined,
  issue = { title: "🔴 Фронт-деплой: broken", createdByAgentId: agentId, executionPolicy: null },
) {
  return cronServiceRequestAllowed(scope, {
    method, path, body, query: "", companyId, agentId,
  }, async (id) => id === issueId ? issue : null, async () => "error");
}

describe("host cron API key scope", () => {
  it("keeps distinct service scopes and rejects unknown or malformed ones", () => {
    expect(agentApiKeyScopeSchema.safeParse({ kind: "cron_service", service: "quota_rewake" }).success).toBe(true);
    expect(agentApiKeyScopeSchema.safeParse({ kind: "cron_service", service: "quota_rewake", extra: true }).success).toBe(false);
    expect(agentApiKeyScopeSchema.safeParse({ kind: "cron_service", service: "unknown" }).success).toBe(false);
  });

  it("allows watchdog recovery but denies credentials, other issues and widened bodies", async () => {
    const scope = { kind: "cron_service", service: "agent_watchdog", alarmIssueIds: [issueId] } as const;
    expect(await request(scope, "GET", `/api/companies/${companyId}/agents`)).toBe(true);
    expect(await request(scope, "PATCH", `/api/agents/${agentId}`, { status: "idle" })).toBe(true);
    expect(await cronServiceRequestAllowed(scope, {
      method: "PATCH", path: `/api/agents/${agentId}`, query: "", body: { status: "idle" }, companyId, agentId,
    }, async () => null, async () => "paused")).toBe(false);
    expect(await request(scope, "PATCH", `/api/agents/${agentId}`, { status: "terminated" })).toBe(false);
    expect(await request(scope, "GET", `/api/agents/${agentId}/keys`)).toBe(false);
    const policy = {
      mode: "normal", stages: [],
      monitor: {
        kind: "external_service", serviceName: "paperclip-board", recoveryPolicy: "wake_owner",
        maxAttempts: 100, nextCheckAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
    };
    expect(await request(scope, "PATCH", `/api/issues/${issueId}`, { executionPolicy: policy },
      { title: "alarm", createdByAgentId: null, executionPolicy: { mode: "normal", stages: [] } })).toBe(true);
    expect(await request(scope, "PATCH", `/api/issues/${issueId}`,
      { executionPolicy: { ...policy, stages: [{ type: "code_review" }] } },
      { title: "alarm", createdByAgentId: null, executionPolicy: { mode: "normal", stages: [] } })).toBe(false);
    expect(await request(scope, "PATCH", `/api/issues/${otherIssueId}`, { executionPolicy: policy })).toBe(false);
    expect(await request(scope, "POST", `/api/issues/${issueId}/comments`, { body: "poke" })).toBe(true);
  });

  it("limits frontend deploy to its own incident and fixed project/assignee", async () => {
    const scope = { kind: "cron_service", service: "deploy_frontend", projectId, assigneeAgentId: pixelAgentId } as const;
    const create = {
      title: "🔴 Фронт-деплой: broken", description: "build failed", priority: "high",
      assigneeAgentId: pixelAgentId, projectId, status: "todo",
    };
    expect(await request(scope, "POST", `/api/companies/${companyId}/issues`, create)).toBe(true);
    expect(await request(scope, "POST", `/api/companies/${companyId}/issues`, { ...create, assigneeAgentId: agentId })).toBe(false);
    expect(await request(scope, "GET", `/api/issues/${issueId}`)).toBe(true);
    expect(await request(scope, "PATCH", `/api/issues/${issueId}`, { status: "done" })).toBe(true);
    expect(await request(scope, "PATCH", `/api/issues/${issueId}`, { status: "blocked" })).toBe(false);
    expect(await request(scope, "POST", `/api/issues/${issueId}/comments`, { body: "recovered" })).toBe(true);
    expect(await request(scope, "GET", `/api/issues/${issueId}`, undefined,
      { title: "🔴 Фронт-деплой: broken", createdByAgentId: pixelAgentId, executionPolicy: null })).toBe(false);
  });

  it("limits quota rewake to reading candidates and cancelling its own work orders", async () => {
    const scope = { kind: "cron_service", service: "quota_rewake" } as const;
    const workOrder = { title: "[quota-rewake] DevOps: return", description: "quota recovered", status: "todo", assigneeAgentId: pixelAgentId, priority: "high" };
    expect(await request(scope, "POST", `/api/companies/${companyId}/issues`, workOrder)).toBe(true);
    expect(await request(scope, "POST", `/api/companies/${companyId}/issues`, { ...workOrder, title: "unrelated" })).toBe(false);
    expect(await request(scope, "GET", `/api/issues/${issueId}`, undefined,
      { title: workOrder.title, createdByAgentId: agentId, executionPolicy: null })).toBe(true);
    expect(await request(scope, "GET", `/api/issues/${issueId}`)).toBe(false);
    expect(await request(scope, "PATCH", `/api/issues/${issueId}`, { status: "cancelled", comment: "superseded" },
      { title: workOrder.title, createdByAgentId: agentId, executionPolicy: null })).toBe(true);
    expect(await request(scope, "PATCH", `/api/issues/${issueId}`, { status: "todo", comment: "takeover" },
      { title: workOrder.title, createdByAgentId: agentId, executionPolicy: null })).toBe(false);
    expect(await request(scope, "POST", `/api/issues/${issueId}/recovery-actions/resolve`, {})).toBe(false);
  });
});
