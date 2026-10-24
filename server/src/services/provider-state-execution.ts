import { ProviderSessionIsolationRequired, type ProviderSessionBinding } from "@paperclipai/adapter-utils";
import { requireIssuedProviderSessionBinding } from "./provider-state-driver.js";

export function isProviderStateAdapter(adapterType: string) {
  return ["codex_local", "claude_local", "acpx_local"].includes(adapterType);
}

/** The rollout switch belongs to the host control plane, never adapter config. */
export function providerStateEnforced(env: Record<string, string | undefined>) {
  return env.PAPERCLIP_PROVIDER_STATE_MODE !== "observe";
}

export async function executeWithProviderState<T>(
  binding: ProviderSessionBinding | null | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  requireIssuedProviderSessionBinding(binding);
  if (!binding) throw new ProviderSessionIsolationRequired();
  await binding.assertWritable();
  return await execute();
}
