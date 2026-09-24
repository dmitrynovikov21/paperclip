type AgentWakeRouting = {
  /** "human_only": agent-authored @-mentions do not wake this agent. */
  agentMentions?: "all" | "human_only";
  /** "never": skip this agent as a manager/creator recovery owner. */
  managerRecovery?: "default" | "never";
};

function readWakeRouting(source: unknown): AgentWakeRouting | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const routing = (source as { wakeRouting: unknown }).wakeRouting;
  return routing && typeof routing === "object" && !Array.isArray(routing) ? routing : null;
}

export function shouldSuppressAgentAuthoredMentionWake(metadata: unknown, adapterConfig?: unknown) {
  return (
    readWakeRouting(adapterConfig)?.agentMentions ??
    readWakeRouting(metadata)?.agentMentions
  ) === "human_only";
}

export function shouldSuppressManagerRecoveryWake(metadata: unknown, adapterConfig?: unknown) {
  return (
    readWakeRouting(adapterConfig)?.managerRecovery ??
    readWakeRouting(metadata)?.managerRecovery
  ) === "never";
}
