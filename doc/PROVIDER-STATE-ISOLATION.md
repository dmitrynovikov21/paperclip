# Provider state isolation

Provider session state belongs to one company, agent, adapter and task. An agent
directory, file mode or plugin metadata flag does not prove isolation. The core
broker requires an installed trusted driver and a fresh probe inside that driver's
untrusted execution boundary.

## Driver and adapter contract

Trusted environment-runtime composition calls `registerTrustedProviderStateDriver`
with approved driver code and the environment configuration. Installation checks
effective identity, groups, capabilities, durable resume, idempotent destruction,
generation fencing and denial of late preparation. All deny probes must pass:
sibling canonical, alias, traversal, symlink and hardlink access; host proc/fd and
inherited control descriptors; Docker, Podman and CRI sockets; sudo, mount,
namespace escape and privileged devices. Missing or successful probes fail closed.
The report must describe attempts made inside the child boundary. A declaration
returned by an arbitrary plugin worker cannot register a driver.

The registered driver identity includes its revision and configuration digest.
The core also binds registration to the environment's identity, driver, config and
environment variable bindings. Configuration changes invalidate use of the old
registration. Image, runner and host changes require installation conformance to
run again. A driver must recompute its digest from these actual inputs when it
probes, and must reject a mismatch. Old registered driver code remains available
for cleanup of its own state after a replacement is installed.

Supply registrations through `environmentRuntimeService`'s `providerStateDrivers`
map, keyed by environment ID. The default local, SSH and sandbox drivers do not
declare this capability. There is no automatic registration based on driver type
or sandbox metadata. A trusted SSH driver needs a private remote principal or
mount and must pass the same conformance contract.

The core issues frozen, process-local `ProviderSessionIsolationAttestation` and
`ProviderSessionBinding` objects. JSON copies are rejected. A binding exposes an
opaque lease ID, generation and `assertWritable()`. Its attestation carries an
opaque UUID state reference, never a host path. Probe validity is one minute.
Each resume obtains a fresh probe; each turn must call `assertWritable()` before
starting its provider child. Finalization checks capability origin and the DB
fence, without requiring the original pre-spawn probe to stay fresh for a long run.

An adapter sets `supportsProviderStateIsolation` only after all of its durable
state and ephemeral credential projections use `ctx.providerSession`. This is a
core code declaration, not an adapter configuration option. The Codex, Claude and
ACPX provider bindings are separate adapter migrations. The core rejects these
adapters before workspace preparation while the declaration is absent.

## Broker and database contract

Derive an opaque scope with `providerStateScope` from the company ID, agent ID,
adapter type and task key. Snapshot the scope generation when a run starts, before
asynchronous preparation. `acquire` checks that generation, reserves a
`provisioning` environment lease and state reference durably, then calls the
trusted driver. Activation uses a DB compare-and-swap after the probe. A reset
before the first acquisition invalidates the earlier snapshot as well.

Acquisition checks the scope against the lease's issue and the owner's current
adapter. A changed adapter or expired execution boundary invalidates use of an
old binding. Expiring or failing a private execution lease tombstones and destroys
its state; a later legacy release cannot restore the revoked generation.

Reusable sandbox matching includes the task scope. A lease from another task is
neither resumed nor destroyed as an obsolete configuration candidate. Resume also
requires the linked environment and provider lease to match the newly acquired
execution boundary. Legacy pointers without a verified link start a fresh session.

`environment_leases` owns the private state status, generation, reference, driver
identity, expiry, cleanup claim and tombstone. `provider_state_scopes` retains the
generation when a pointer or owner is deleted. `agent_task_sessions` links the
lease and generation privately. Public lease/session projections exclude these
broker fields. No broker operation exports provider files or raw state.

`commitSession` writes the task pointer and `heartbeat_runs.sessionIdAfter` in one
transaction, under the scope and lease locks. Reset, terminal transitions,
agent termination, issue/agent/company deletion and company archive invalidate
the same fence and clear pointers before external teardown. Acquisition shares
owner and environment row locks so a deletion cannot miss a new provisioning
lease. Late finalization cannot recreate an invalidated pointer or overwrite a
fresh generation. Runtime-state session fallback is disabled in enforcement mode.

## Cleanup and expiry

Lifecycle states are `provisioning -> active -> pending_cleanup -> destroyed`.
Failures remain `cleanup_failed`, non-resumable, with the tombstone intact. Cleanup
uses a generation-bound claim with an expiry so a crash cannot hold it forever.

The driver must stop new turns and acknowledge that no writer remains. The broker
first requests quiescence. After timeout or failure it requests termination of the
whole boundary. It then revokes mounts/descriptors/credential projections and
destroys state. Each step has a 30-second bound. Drivers must honor cancellation
and their generation fence, including preparation that finishes after teardown.
An unsuccessful termination acknowledgement prevents successful cleanup.

`retryCleanup` is idempotent. Pending/failed state prevents issue, agent, company
and environment deletion from dropping its cleanup record. Cleanup errors persist
only fixed enums; driver exception text is excluded. Retention workers can select
pending or failed rows and reclaim expired claims. The retention worker and
backup/erasure orchestration are separate integrations.

Idle expiry is seven days. Touch cannot extend the lease past its 30-day hard cap.
Expired state refuses resume and pointer writes; the retention worker destroys it.
No old transcript is imported into a fresh scope.

## Rollout and verification

The host control-plane environment controls `PAPERCLIP_PROVIDER_STATE_MODE`.
The default and every unknown value enforce isolation. `observe` is the explicit
pre-migration rollout phase. Adapter config, issue content and child environment
overrides do not select this mode. A production downgrade is a separate operator
decision; it must not restore raw central persistence or provider-file export.

Install the schema before the server code. Enforce only with approved drivers and
completed provider bindings. Do not deploy this broker change alone to a fleet
that still needs unbound provider execution. Runtime installation, host storage
changes and production probes require the release window and its operator gates.
The broker does not provision a production boundary itself.

Run the synthetic DB/conformance suite with:

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/provider-state-broker.test.ts
```

The suite starts its own disposable PostgreSQL instance on a random loopback port
and creates a distinct test role. It covers missing/forged/stale capabilities,
every failed deny probe, foreign scopes, configuration drift, reset before acquire,
late preparation, a real stuck synthetic child, late pointer writes, cleanup
retry, owner deletion and fake-clock expiry. Driver reports in this suite are
synthetic. They test capability validation and lifecycle; they do not attest a
production OS boundary. Release QA must run actual sibling/host-control probes
inside each installed production driver, as well as cross-provider resume tests.
