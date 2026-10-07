/** Core-issued capability. Serialized driver/plugin metadata is not a capability. */
export interface ProviderStateScope {
  companyId: string;
  agentId: string;
  adapterType: string;
  taskScopeId: string;
}

export const PROVIDER_STATE_BOUNDARY_KINDS = [
  "private_mount", "isolated_container", "isolated_vm", "dedicated_os_principal",
] as const;

export interface ProviderSessionIsolationAttestation {
  readonly version: 1;
  readonly scope: Readonly<ProviderStateScope>;
  readonly boundaryKind: typeof PROVIDER_STATE_BOUNDARY_KINDS[number];
  readonly durableResume: true;
  readonly siblingRead: "denied";
  readonly hostRootsMounted: false;
  readonly hostControlDenied: true;
  readonly destroySupported: true;
  readonly stateRef: string;
  readonly provider: string;
  readonly providerRevision: string;
  readonly configurationDigest: string;
  readonly expiresAt: string;
  readonly verification: Readonly<{
    installConformance: "passed";
    environmentProbe: "passed";
    checkedAt: string;
    validUntil: string;
  }>;
}

/** Private adapter context; do not copy this into events, results or public API. */
export interface ProviderSessionBinding {
  readonly leaseId: string;
  readonly generation: number;
  readonly attestation: ProviderSessionIsolationAttestation;
  /** Re-check the DB fence immediately before starting a provider turn. */
  assertWritable(): Promise<void>;
}

export class ProviderSessionIsolationRequired extends Error {
  readonly code = "provider_session_isolation_required";
  constructor() {
    super("provider_session_isolation_required");
    this.name = "ProviderSessionIsolationRequired";
  }
}
