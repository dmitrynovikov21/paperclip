import type { RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { HostWatcherAgentKeyScope } from "@paperclipai/shared";

type WatchedIssue = {
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  projectId: string | null;
};

type WatcherRequest = {
  method: string;
  path: string;
  query: string;
  body: unknown;
  companyId: string;
  serviceAgentId: string;
};

const UUID = "[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}";
const ISSUE_PATH = new RegExp(`^/api/issues/(${UUID})(/comments)?$`);
const CREATE_PATH = new RegExp(`^/api/companies/(${UUID})/issues$`);
const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];

function hasOnlyKeys(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/** Exact HTTP capability for a board-issued host watcher key. Normal route authorization still applies. */
export async function hostWatcherRequestAllowed(
  scope: HostWatcherAgentKeyScope,
  request: WatcherRequest,
  loadIssue: (id: string) => Promise<WatchedIssue | null>,
  hasOpenWorkOrder: (serviceAgentId: string) => Promise<boolean>,
): Promise<boolean> {
  if (request.query) return false;
  const issuePath = ISSUE_PATH.exec(request.path);
  const targetId = issuePath?.[1]?.toLowerCase();
  const scopeIssueId = scope.issueId.toLowerCase();

  if (scope.service === "fleet_hourly" && request.method === "POST"
    && CREATE_PATH.exec(request.path)?.[1]?.toLowerCase() === request.companyId.toLowerCase()) {
    if (!hasOnlyKeys(request.body, ["title", "description", "status", "priority", "assigneeAgentId", "parentId"])) return false;
    if (!boundedText(request.body.title, 180) || !request.body.title.startsWith("[watch][hourly] ")
      || !boundedText(request.body.description, 12_000)
      || request.body.status !== "todo" || request.body.priority !== "high"
      || request.body.assigneeAgentId !== scope.assigneeAgentId
      || request.body.parentId !== scope.issueId) return false;
    const parent = await loadIssue(scope.issueId);
    return Boolean(parent && parent.companyId === request.companyId && parent.projectId === scope.projectId
      && parent.status !== "done" && parent.status !== "cancelled"
      && !(await hasOpenWorkOrder(request.serviceAgentId)));
  }

  if (!targetId || targetId !== scopeIssueId) return false;
  const issue = await loadIssue(scope.issueId);
  if (!issue || issue.companyId !== request.companyId) return false;

  if (scope.service === "fleet_hourly") {
    return request.method === "POST" && issuePath?.[2] === "/comments"
      && issue.projectId === scope.projectId
      && hasOnlyKeys(request.body, ["body"]) && boundedText(request.body.body, 12_000);
  }

  if (issue.assigneeAgentId !== scope.assigneeAgentId) return false;
  if (scope.service !== "disk_guard" && request.method === "GET" && !issuePath?.[2]) {
    return request.body === undefined || request.body === null;
  }
  if (issue.status === "done" || issue.status === "cancelled" || issue.status === "in_review") return false;

  if (scope.service !== "disk_guard" && request.method === "POST" && issuePath?.[2] === "/comments") {
    return hasOnlyKeys(request.body, ["body"]) && boundedText(request.body.body, 16_000);
  }
  if (request.method !== "PATCH" || issuePath?.[2]
    || !hasOnlyKeys(request.body, ["status", "comment"])
    || !boundedText(request.body.comment, scope.service === "disk_guard" ? 4_000 : 16_000)) return false;

  if (scope.service === "disk_guard") return request.body.status === "todo";
  const resumeStatus = scope.service === "pr_923" ? "todo" : "in_progress";
  return issue.status === "blocked" && request.body.status === resumeStatus;
}

export function hostWatcherKeyGuard(db: Db): RequestHandler {
  return async (req, res, next) => {
    const actor = req.actor;
    if (actor.type !== "agent" || actor.keyScope?.kind !== "host_watcher") return next();
    if (actor.source !== "agent_key" || !actor.agentId || !actor.companyId || !actor.keyId) {
      res.status(403).json({ error: "Host watcher scope requires its issued API key" });
      return;
    }
    const url = new URL(req.originalUrl, "http://localhost");
    try {
      const allowed = await hostWatcherRequestAllowed(actor.keyScope, {
        method: req.method,
        path: url.pathname,
        query: url.search,
        body: req.body,
        companyId: actor.companyId,
        serviceAgentId: actor.agentId,
      }, async (id) => db.select({
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        projectId: issues.projectId,
      }).from(issues).where(and(eq(issues.id, id), eq(issues.companyId, actor.companyId!)))
        .then((rows) => rows[0] ?? null), async (serviceAgentId) => db.select({ id: issues.id })
        .from(issues).where(and(
          eq(issues.companyId, actor.companyId!),
          eq(issues.originKind, "host_watcher"),
          eq(issues.originId, serviceAgentId),
          inArray(issues.status, OPEN_STATUSES),
        )).limit(1).then((rows) => rows.length > 0));
      if (!allowed) {
        res.status(403).json({ error: "API operation is outside this host watcher key's scope" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
