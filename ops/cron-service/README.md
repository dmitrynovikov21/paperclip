# HELA-12871: host cron identity boundary

This directory stages the three cron changes. `prepare-host.sh --check` checks
the reviewed host source hashes, strips the old DB password literals from the
staged copies, applies the patches, and checks Python and shell syntax. It does
not change the live host. Running without `--check` requires root and an explicit
`HELA12871_FOUNDER_GO=1`; it installs code and units but does not enable them or
touch live credentials.

## Boundary

| Job | Execution | API identity | Secret source |
| --- | --- | --- | --- |
| Agent watchdog | `pc-cron-watchdog`, root-owned script | `cron_service/agent_watchdog`, fixed alarm issue IDs | service home `.secrets`, mode 0400 |
| Quota re-wake | `pc-cron-quota`, root-owned script | `cron_service/quota_rewake`, nudge orders only | service home `.secrets`, mode 0400 |
| Frontend deploy | build remains `paperclip-user`; API broker runs as `pc-cron-deploy` | `cron_service/deploy_frontend`, fixed project/assignee and own incidents | `/etc/paperclip-cron/deploy-frontend.token`, mode 0400 |

The frontend build must never run under `pc-cron-deploy`: the source checkout is
agent-writable. Its API calls use `api_client.py` over a Unix socket. An agent can
ask the broker to perform an operation, but cannot read its key; the Paperclip
API enforces the service key's method, path, body, and issue boundary. The broker
fixes the upstream host and refuses redirects so a caller cannot steer its key
to another server.

The watchdog and quota scripts still query the control-plane DB. The staged
copies read `WATCHDOG_PG` and `QR_PG` from root-managed service environment files.
The old DB password literal exists in agent-readable host copies and backups:
**rotate that DB password and verify the old credential is rejected at cutover**.
Use dedicated DB roles with only the needed tables/functions, subject to the
architecture verdict in the linked issue. Moving files alone does not close the
old DB path.

## Cutover after founder go and architecture/security review

1. Create three non-executing Paperclip service agents in the target company.
   Create one API key for each with the matching `cron_service` scope. The
   watchdog scope lists the four current alarm issue UUIDs; the frontend scope
   fixes the HelloPrint project UUID and Pixel UI assignee UUID. Record key IDs,
   not token values. Creation and revocation must be done through the board
   authority; no agent impersonation.
2. Run `prepare-host.sh --check`. If a source hash changed, refresh the patches
   and review; do not force patching. For root staging, fetch the approved commit
   into a **root-owned, clean** checkout under
   `/opt/paperclip-cron-release/<sha>` and set `HELA12871_APPROVED_SHA` to that
   exact commit. Never execute a root installer from an agent-writable worktree.
   Keep the existing crontab active until each service is configured and its
   smoke passes.
3. Under `/var/lib/pc-cron-watchdog/.secrets/`, install the watchdog token as
   `paperclip-cron-agent-watchdog.token` and a `paperclip-bridge.env` containing
   only `PAPERCLIP_API_URL`. Under `/var/lib/pc-cron-quota/.secrets/`, install
   `paperclip-cron-quota-rewake.token`. Set owner to the respective service UID
   and mode 0400; service home and `.secrets` must deny `paperclip-user` traversal.
4. Create `/etc/paperclip-cron/watchdog.env` with `WATCHDOG_PG`,
   `/etc/paperclip-cron/quota.env` with `QR_PG`, `QR_AGENT_ID`, `QR_COMPANY`,
   `QR_API`, and `/etc/paperclip-cron/deploy.env` with
   `CRON_SERVICE_API_URL`. Each DB env file must be readable only by its service
   UID/root. Copy quota `state.json` and watchdog poke state into the new
   service homes with matching ownership. Do not install a board key or
   `PAPERCLIP_OPS_TOKEN` for these services.
5. Start the deploy broker, then run its scoped HTTP smoke. Verify one manual
   watchdog and quota service tick, without enabling timers. Stage the reviewed
   frontend patch from `/opt/paperclip-cron/deploy-frontend.sh.staged` into the
   existing agent-owned deploy script; the cron entry still runs under the agent
   UID, but no longer opens a token file.
6. Remove only the three old cron entries (watchdog, quota, frontend deploy),
   then add the frontend entry back with the patched script and enable the two
   new timers. Keep an exact crontab backup. Do not touch CI workflows or runs.
7. Confirm two normal ticks per job. The new keys' `last_used_at` must increase;
   ordinary logs must have no 401/403. Revoke the three old `standard` keys and
   remove the old token files from agent-readable locations. Rotate the old DB
   password, scan agent worktrees/backups for readable copies, and verify the old
   credential no longer authenticates. Do not log credentials or API responses
   that could contain them.

## Negative and positive smoke

- As `paperclip-user`, `test -r` must fail for all three new token sources and
  DB env files. Repeat in ordinary local shell, ACPX shell, sandbox/remote
  execution, and a copied worktree. Record UID, path, and boolean result only.
- Via the frontend socket, `GET /api/agents/<id>/keys` must return 403 while
  the deploy incident create/read/comment/close flow succeeds. Direct agent
  shell API calls with the agent's own run JWT must not gain cron-only rights.
- Start the watchdog once and verify agent recovery plus alarm re-arm/comment;
  start quota once and verify a scoped nudge order. Confirm their keys cannot
  call a forbidden endpoint or mutate an unrelated issue. Capture only status
  codes, issue IDs, and `last_used_at` timestamps.
- Run the existing run-scoped JWT regression suite before and after API rollout.

If a smoke fails before revocation, stop the new service/timer and restore only
the old cron entry for that job within the approved window. After revocation,
repair or reissue the scoped service key; never restore an agent-readable
`standard` key.
