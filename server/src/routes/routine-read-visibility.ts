import type { Request } from "express";

type RoutineWithEnv = {
  companyId: string;
  assigneeAgentId: string | null;
  env?: unknown;
};

// Match the write boundary used by PATCH /routines/:id, including read-only
// board memberships and agents acting for a read-only responsible user.
export function canReadRoutineEnv(req: Request, routine: RoutineWithEnv): boolean {
  const actor = req.actor;
  if (actor.type === "board") {
    if (actor.source === "local_implicit" || actor.isInstanceAdmin) return true;
    if (!Array.isArray(actor.memberships)) return true;
    const membership = actor.memberships.find((item) => item.companyId === routine.companyId);
    return membership?.status === "active" && membership.membershipRole !== "viewer";
  }
  if (actor.type !== "agent" || !actor.agentId || actor.agentId !== routine.assigneeAgentId) {
    return false;
  }
  if (!actor.onBehalfOfUserId?.trim()) return true;
  const membership = actor.onBehalfOfMemberships?.find((item) => item.companyId === routine.companyId);
  return membership?.status === "active" && membership.membershipRole !== "viewer";
}

export function routineForRead<T extends RoutineWithEnv>(req: Request, routine: T): T | Omit<T, "env"> {
  if (canReadRoutineEnv(req, routine)) return routine;
  const { env: _env, ...visible } = routine;
  return visible;
}
