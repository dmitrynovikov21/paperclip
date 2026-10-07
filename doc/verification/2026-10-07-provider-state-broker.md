# Provider state broker verification — 2026-10-07

This report covers the broker foundation and synthetic integration tests. It does
not attest a production OS boundary. No production driver was installed and no
runtime or host-storage rollout was performed.

## Change and requirements

| Requirement | Implementation and evidence |
| --- | --- |
| Trusted isolation capability | Core driver registration; revision and environment digest; process-local frozen attestation and binding; negative tests for every deny probe and forged serialized metadata. |
| Task scope | Canonical issue and current owner adapter checks; task scope in reusable sandbox matching; same-task resume and foreign-task preservation test. |
| Generation fence | Durable scope generation; atomic session link plus `sessionIdAfter`; tombstone before external teardown; late acquire/finalization and pointer-deletion regressions. |
| Lifecycle | Bounded quiesce, force termination, revoke and destroy; persisted cleanup failures and retry claim; reset, terminal, archive, lease expiry and owner deletion tests. |
| Retention | Seven-day idle and thirty-day hard cap; fake-clock expiry tests. Production sweeps and backup erasure are separate integrations. |

## Checks

Node.js v22.22.2 and pnpm 9.15.4 were used locally.

- Full workspace typecheck: PASS.
- Full workspace build: PASS.
- Final server typecheck and build after the last lifecycle changes: PASS.
- Targeted regression: **82/82 passed** across four test files, including 43 new broker/conformance tests. Each DB suite uses its own disposable PostgreSQL cluster. The broker suite adds a distinct generated role and checks its loopback port before use.
- Shared package: 51 files, 425 tests passed.
- Skills catalog: 5 files, 20 tests passed.

Targeted command:

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/provider-state-broker.test.ts \
  src/__tests__/environment-runtime.test.ts \
  src/__tests__/environment-runtime-driver-contract.test.ts \
  src/__tests__/heartbeat-run-lease-release-terminalization.test.ts
```

The full regression is **not green**. Its first server pass used the earlier
resume fixture, which was corrected and is green in the final targeted run.
It also reported a workspace-busy failure and an interaction timeout. That local
server pass was stopped after the failures; later serialized suites were not run.
The broad UI run passed 3707 tests and failed three tests in cases routing and the
provider-test button. The DB package run passed 187 tests and timed out in four
old migration reapply tests (source and built copies).

A separate checkout of the exact base server source was tested with the same
installed dependency and DB layer. Both the changed and base server failed the
same two workspace-busy assertions: retry cancellation after reassignment and
continued deferral while a holder is live. This comparison covers those failures;
it does not establish that every broad-suite failure predates this change.
No UI source was changed.

## GitHub CI prerequisites

PR policy passed. Code jobs stop at frozen dependency installation with
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`: the base lockfile does not match
`patchedDependencies`. The local regenerated lockfile was excluded from this PR.
The automatic review job also stops before reviewing code because its
`COMMITPERCLIP_KEY` environment binding is absent.

Evidence on head `dab9fa2a6f29975e40c0d8882d796665329c3626`:
[dependency job](https://github.com/dmitrynovikov21/paperclip/actions/runs/37612699527/job/112763764000),
[review prerequisite](https://github.com/dmitrynovikov21/paperclip/actions/runs/37612696191/job/112763529372).
Workflow configuration was unchanged. No GitHub run was cancelled or disabled.
The PR remains a draft. Native code and security review have not been requested
while these code checks are red.

The lockfile repair already has [PR #14](https://github.com/dmitrynovikov21/paperclip/pull/14),
which remains open and awaits a human decision. This broker branch does not copy
its lockfile or depend on its unmerged branch. After the repair reaches the base,
rebuild this branch on that base and complete the code checks before native review.
The missing automatic-review key is a known, non-applicable check on this fork;
restoring that key is not a prerequisite for this change.

## Counts-only inventory

Snapshot time: 2026-10-07 10:28:38 UTC. Existing provider carrier contents opened: **0**.

| Carrier class | File count |
| --- | ---: |
| Codex JSONL | 4496 |
| Claude JSONL | 7540 |
| ACPX session JSON | 12269 |
| ACPX stderr files | 20712 |

The inventory contains counts only. It contains no paths, transcript values,
credential values or copied provider data.

## Control-plane handoff recovery

The previous heartbeat credential expired at 10:49 UTC. Paperclip returned HTTP
401 for both agent authentication and blocker creation. The report and PR are
saved in GitHub. The previous run later ended on its output-inactivity monitor.
Access was restored in a fresh authorized heartbeat at 11:37 UTC, which recorded
the recovery checkpoint and confirmed the exact PR head and current CI failures.
No product code changed during recovery, and the earlier test results above were
not rerun. The next action is the existing lockfile repair's human decision, then
green code checks and the configured native code and security review stages.
