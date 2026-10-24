import { createHash } from "node:crypto";
import {
  PROVIDER_STATE_BOUNDARY_KINDS,
  ProviderSessionIsolationRequired,
  type ProviderSessionIsolationAttestation,
  type ProviderSessionBinding,
  type ProviderStateScope,
} from "@paperclipai/adapter-utils";

export const PROVIDER_STATE_DENY_PROBES = [
  "sibling_canonical", "sibling_alias", "sibling_traversal", "sibling_symlink", "sibling_hardlink",
  "host_proc_fd", "inherited_host_fd", "docker_socket", "podman_socket", "cri_socket",
  "sudo", "mount", "namespace_escape", "privileged_device",
] as const;

/** The trusted driver runs these attempts INSIDE its untrusted child boundary. */
export interface ProviderStateConformance {
  version: 1;
  configurationDigest: string;
  effectiveIdentityChecked: true;
  supplementaryGroupsChecked: true;
  capabilitiesChecked: true;
  hostRootsMounted: false;
  durableResume: true;
  idempotentDestroy: true;
  generationFenceVerified: true;
  latePrepareDenied: true;
  probes: Record<typeof PROVIDER_STATE_DENY_PROBES[number], "denied">;
}

export interface ProviderStateDriverRequest {
  scope: ProviderStateScope;
  environmentId: string;
  leaseId: string;
  generation: number;
  stateRef: string;
}

/** Only approved core-owned driver code may be registered. No plugin RPC flags. */
export interface TrustedProviderStateDriver {
  id: string;
  revision: string;
  configurationDigest: string;
  environmentDriver: string;
  boundaryKind: typeof PROVIDER_STATE_BOUNDARY_KINDS[number];
  installConformance(signal: AbortSignal): Promise<ProviderStateConformance>;
  prepare(request: ProviderStateDriverRequest, signal: AbortSignal): Promise<ProviderStateConformance>;
  probe(request: ProviderStateDriverRequest, signal: AbortSignal): Promise<ProviderStateConformance>;
  quiesce(request: ProviderStateDriverRequest, signal: AbortSignal): Promise<void>;
  terminateBoundary(request: ProviderStateDriverRequest, signal: AbortSignal): Promise<void>;
  revokeProjections(request: ProviderStateDriverRequest, signal: AbortSignal): Promise<void>;
  destroy(request: ProviderStateDriverRequest, signal: AbortSignal): Promise<void>;
}

export interface TrustedProviderStateDriverRegistration {
  readonly id: string;
}

type ProviderStateEnvironmentIdentity = { id: string; driver: string; config: unknown; envVars: unknown };

type Registration = { driver: Readonly<TrustedProviderStateDriver>; active: boolean; environmentDigest: string | null };
const registrations = new WeakMap<TrustedProviderStateDriverRegistration, Registration>();
const currentDrivers = new Map<string, TrustedProviderStateDriverRegistration>();
const cleanupDrivers = new Map<string, Readonly<TrustedProviderStateDriver>>();
const issuedAttestations = new WeakMap<ProviderSessionIsolationAttestation, {
  registration: TrustedProviderStateDriverRegistration;
  request: ProviderStateDriverRequest;
}>();
const issuedBindings = new WeakSet<ProviderSessionBinding>();
export const PROVIDER_STATE_OPERATION_TIMEOUT_MS = 30_000;
export const PROVIDER_STATE_PROBE_VALIDITY_MS = 60_000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, stableValue(entry)]));
  return value;
}

function environmentDigest(environment: ProviderStateEnvironmentIdentity) {
  return createHash("sha256").update(JSON.stringify(stableValue({ id: environment.id,
    driver: environment.driver, config: environment.config, envVars: environment.envVars }))).digest("hex");
}

export async function boundedProviderStateOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = PROVIDER_STATE_OPERATION_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderSessionIsolationRequired());
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cleanupKey(id: string, revision: string, digest: string) {
  return `${id}:${revision}:${digest}`;
}

function requireConformance(report: ProviderStateConformance, digest: string) {
  if (!report || report.version !== 1 || report.configurationDigest !== digest ||
      report.effectiveIdentityChecked !== true || report.supplementaryGroupsChecked !== true ||
      report.capabilitiesChecked !== true || report.hostRootsMounted !== false ||
      report.durableResume !== true || report.idempotentDestroy !== true ||
      report.generationFenceVerified !== true || report.latePrepareDenied !== true ||
      PROVIDER_STATE_DENY_PROBES.some((probe) => report.probes?.[probe] !== "denied")) {
    throw new ProviderSessionIsolationRequired();
  }
}

/** Installation gate, called by trusted environment-runtime composition only. */
export async function registerTrustedProviderStateDriver(
  driver: TrustedProviderStateDriver,
  environment?: ProviderStateEnvironmentIdentity,
): Promise<TrustedProviderStateDriverRegistration> {
  const safeIdentity = /^[a-zA-Z0-9_.-]{1,80}$/;
  if (!safeIdentity.test(driver.id) || !safeIdentity.test(driver.revision) ||
      !/^[a-f0-9]{64}$/.test(driver.configurationDigest) ||
      !(PROVIDER_STATE_BOUNDARY_KINDS as readonly string[]).includes(driver.boundaryKind) ||
      ["installConformance", "prepare", "probe", "quiesce", "terminateBoundary", "revokeProjections", "destroy"]
        .some((key) => typeof driver[key as keyof TrustedProviderStateDriver] !== "function")) {
    throw new ProviderSessionIsolationRequired();
  }
  const snapshot = Object.freeze({ ...driver,
    installConformance: driver.installConformance.bind(driver), prepare: driver.prepare.bind(driver),
    probe: driver.probe.bind(driver), quiesce: driver.quiesce.bind(driver),
    terminateBoundary: driver.terminateBoundary.bind(driver), revokeProjections: driver.revokeProjections.bind(driver),
    destroy: driver.destroy.bind(driver),
  });
  try {
    requireConformance(
      await boundedProviderStateOperation((signal) => snapshot.installConformance(signal)),
      snapshot.configurationDigest,
    );
  } catch {
    throw new ProviderSessionIsolationRequired();
  }
  const previous = currentDrivers.get(snapshot.id);
  if (previous) registrations.get(previous)!.active = false;
  const registration = Object.freeze({ id: snapshot.id });
  registrations.set(registration, { driver: snapshot, active: true,
    environmentDigest: environment ? environmentDigest(environment) : null });
  currentDrivers.set(snapshot.id, registration);
  cleanupDrivers.set(cleanupKey(snapshot.id, snapshot.revision, snapshot.configurationDigest), snapshot);
  return registration;
}

export function requireTrustedProviderStateDriver(registration: TrustedProviderStateDriverRegistration) {
  const record = registration && registrations.get(registration);
  if (!record?.active || currentDrivers.get(record.driver.id) !== registration) {
    throw new ProviderSessionIsolationRequired();
  }
  return record.driver;
}

export function requireProviderStateDriverForEnvironment(
  registration: TrustedProviderStateDriverRegistration,
  environment: ProviderStateEnvironmentIdentity,
) {
  const driver = requireTrustedProviderStateDriver(registration);
  if (driver.environmentDriver !== environment.driver ||
      registrations.get(registration)?.environmentDigest !== environmentDigest(environment)) {
    throw new ProviderSessionIsolationRequired();
  }
  return driver;
}

export function requireCurrentProviderStateDriver(id: string, revision: string, digest: string,
  environment: ProviderStateEnvironmentIdentity) {
  const registration = currentDrivers.get(id);
  if (!registration) throw new ProviderSessionIsolationRequired();
  const driver = requireProviderStateDriverForEnvironment(registration, environment);
  if (driver.revision !== revision || driver.configurationDigest !== digest) throw new ProviderSessionIsolationRequired();
}

export function issueProviderSessionBinding(binding: ProviderSessionBinding) {
  if (!issuedAttestations.has(binding.attestation)) throw new ProviderSessionIsolationRequired();
  const sealed = Object.freeze(binding);
  issuedBindings.add(sealed);
  return sealed;
}

export function requireIssuedProviderSessionBinding(binding: ProviderSessionBinding | null | undefined) {
  if (!binding || !issuedBindings.has(binding)) throw new ProviderSessionIsolationRequired();
}

export function getProviderStateCleanupDriver(id: string, revision: string, digest: string) {
  return cleanupDrivers.get(cleanupKey(id, revision, digest)) ?? null;
}

export async function attestProviderSessionIsolation(input: {
  registration: TrustedProviderStateDriverRegistration;
  request: ProviderStateDriverRequest;
  expiresAt: Date;
  now: Date;
  prepare?: boolean;
}): Promise<ProviderSessionIsolationAttestation> {
  const driver = requireTrustedProviderStateDriver(input.registration);
  let report: ProviderStateConformance;
  try {
    report = await boundedProviderStateOperation((signal) =>
      input.prepare ? driver.prepare(input.request, signal) : driver.probe(input.request, signal),
    );
  } catch {
    throw new ProviderSessionIsolationRequired();
  }
  requireTrustedProviderStateDriver(input.registration);
  requireConformance(report, driver.configurationDigest);
  if (input.expiresAt.getTime() <= input.now.getTime()) throw new ProviderSessionIsolationRequired();
  const attestation: ProviderSessionIsolationAttestation = Object.freeze({
    version: 1,
    scope: Object.freeze({ ...input.request.scope }),
    boundaryKind: driver.boundaryKind,
    durableResume: true,
    siblingRead: "denied",
    hostRootsMounted: false,
    hostControlDenied: true,
    destroySupported: true,
    stateRef: input.request.stateRef,
    provider: driver.id,
    providerRevision: driver.revision,
    configurationDigest: driver.configurationDigest,
    expiresAt: input.expiresAt.toISOString(),
    verification: Object.freeze({
      installConformance: "passed",
      environmentProbe: "passed",
      checkedAt: input.now.toISOString(),
      validUntil: new Date(Math.min(input.expiresAt.getTime(), input.now.getTime() + PROVIDER_STATE_PROBE_VALIDITY_MS)).toISOString(),
    }),
  });
  issuedAttestations.set(attestation, {
    registration: input.registration,
    request: { ...input.request, scope: { ...input.request.scope } },
  });
  return attestation;
}

export function requireProviderSessionAttestation(
  attestation: ProviderSessionIsolationAttestation | null | undefined,
  request: ProviderStateDriverRequest,
  now: Date,
  options: { finalization?: boolean } = {},
) {
  const issued = attestation && issuedAttestations.get(attestation);
  if (!issued || !attestation || attestation.version !== 1 ||
      (!options.finalization && now.getTime() >= Date.parse(attestation.verification.validUntil)) ||
      now.getTime() >= Date.parse(attestation.expiresAt) ||
      issued.request.leaseId !== request.leaseId || issued.request.generation !== request.generation ||
      issued.request.environmentId !== request.environmentId || issued.request.stateRef !== request.stateRef ||
      Object.keys(request.scope).some((key) =>
        issued.request.scope[key as keyof ProviderStateScope] !== request.scope[key as keyof ProviderStateScope])) {
    throw new ProviderSessionIsolationRequired();
  }
  requireTrustedProviderStateDriver(issued.registration);
}
