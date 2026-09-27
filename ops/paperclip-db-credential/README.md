# Paperclip DB credential migration (review artifact)

This directory contains templates. **Do not install or run them on the live host before founder approval.** No live DSN, password, key, schedule or current host script is stored here.

## Trust boundary

- The Paperclip control plane runs as `paperclip-svc`. Its PostgreSQL URL is a systemd credential exposed only through `PAPERCLIP_DATABASE_URL_FILE`; `config.json` keeps `database.mode: "postgres"` but has no `database.connectionString`. Its adjacent `.env` has no `DATABASE_URL` or `DATABASE_MIGRATION_URL`. The service URL is never passed as a child environment value.
- An untrusted local CLI agent must have `filesystemScope: "workspace"`. The bwrap mount and PID namespaces omit `/run/credentials`, the service config directory and host `/proc`. Reject any `filesystemExtraPaths` or managed path that reintroduces them. If bwrap or unprivileged user namespaces are unavailable, this local path must fail closed; move that agent to an SSH environment under a different UID or to an isolated sandbox. An ACPX agent must run in an isolated sandbox or SSH environment under a different host UID. Direct ACPX local and other unconfined local adapters are **not eligible** for this deployment.
- All agent-accessible workspaces, worktree `.paperclip/config.json`, `.env`, runtime homes and copied project trees must be scanned for the old URL before activation. Do not seed a worktree from the live PostgreSQL source after the migration. Host runtime services and shell bridges that can execute as `paperclip-svc` must be disabled or moved to an isolated runner before activation; a mount namespace around the main CLI alone cannot protect a host command launched by the service.
- Each host job runs as `pcjob-<instance>`, with its own URL and PostgreSQL role. The job credential source is distinct from the service credential. The six job scripts are installed root-owned with no inline DSN. An agent UID has neither the service nor job credential file in its namespace or permissions.

## Reviewable migration map for files outside this repository

| Source file | Unit instance | Installed target | DB source after rewrite | Minimum role to grant after SQL audit |
| --- | --- | --- | --- | --- |
| `~/daily-report.py` | `daily` | `jobs/daily-report.py` | `os.environ["DATABASE_URL"]` | report tables, read only |
| `~/fleet-hourly-watch.py` | `fleet` | `jobs/fleet-hourly-watch.py` | `os.environ["DATABASE_URL"]` | monitored tables, read only |
| `~/agent-watchdog.py` | `watchdog` | `jobs/agent-watchdog.py` | `os.environ["DATABASE_URL"]` | exact watchdog read/write objects |
| `~/testdb-gc.sh` | `testgc` | `jobs/testdb-gc.sh` | `$DATABASE_URL` | only disposable test DB ownership/cleanup |
| `~/hela3909-deploy-wip-cap.sh` | `wipcap` | `jobs/hela3909-deploy-wip-cap.sh` | `$DATABASE_URL` | exact cap read/write objects |
| `~/disk-alert.sh` | `disk` | `jobs/disk-alert.sh` | `$DATABASE_URL` | alert inputs, read only |

The table is a rewrite contract, not a copy of the live scripts. DevOps must inspect each SQL statement and replace its inline URL with the indicated environment read, then review the resulting redacted diff before installation. A role starts with `CONNECT` only; grant table/function rights individually after the audit. `testdb-gc` must not inherit the Paperclip service role or superuser rights. If a job cannot be made least-privilege, keep it disabled and escalate the exact SQL/permission conflict.

## Ordered live runbook — founder go required

1. Record SHA, approved PR, existing unit/cron schedule, service status and backup location. Take an encrypted database backup and private copies of the seven original files; verify restore in a disposable environment. Keep backup and rollback material outside agent-readable homes and worktrees.
2. Provision separate OS users and a private `/etc/paperclip/credentials` tree. Install a reviewed Paperclip build root-owned and readable by `paperclip-svc` at `/opt/paperclip/app`, and migrate the instance data/config to `/var/lib/paperclip` with private ownership. Adjust any absolute workspace/runtime paths for the new UID. Create a new service DB role and six separate job roles with unique generated passwords. Grant only required objects after reviewing each script's SQL. Restrict direct DB network access to the service/job identities where the host firewall allows it.
3. Rewrite the seven carriers according to the map; remove inline DSNs from `config.json`, the six scripts, adjacent `.env` files, cron definitions and worktree copies. Install the service drop-in, the host job unit and the six redacted root-owned scripts. Provision each job's exact filesystem write paths and DB grants from its reviewed code. Replace old user crons with root-owned schedules that call `systemctl start paperclip-host-job@<instance>.service`; preserve exact schedules from the recorded inventory. Do not print environment values in journal or diagnostics.
4. Before restart, verify every local adapter's mount namespace policy and every ACPX/sandbox/remote target. Reject unsafe host runtime service definitions, extra mounts, references to the service home, and worktree copies. Scan by name and mode; compare candidate file contents with the old URL **in memory** and report counts/paths only. Never print matches or the URL.
   Run `verify-copies.py --old-url-file <private-old-url-file> --carrier <each of seven migrated files> --carrier /opt/paperclip/app/.env --worktree-root <each agent worktree root>` from an operator shell; omit the application `.env` carrier only if it does not exist. It scans every regular worktree file for the old URL and checks named carriers and `.paperclip` config/env files for inline DB credentials. It reports paths, modes and reason codes only. Run it again after rotation. A missing or symlinked carrier and a symlinked `.paperclip` path fail the gate. Review other worktree symlink targets through the mount policy.
5. Start the service, then trigger each job once in a controlled window. Verify real Paperclip `/api/health`, a run-scoped API JWT login/authorized request, and each job's expected DB action against the real backend. Record service/job exit codes, DB role name and safe result counts only.
6. Revoke the old DB role's LOGIN, then rotate its password, terminate old sessions and verify the old URL fails from an agent UID. Repeat the no-copy scan. Retire old cron entries only after their replacement jobs pass. Security performs an independent negative read/connect test.

## Rollback

If the service or a required job fails, stop only the **new** service/job units, preserve logs without secret values and restore the previous config/scripts from the private backup under the original owner. Restore the old DB role only if rollback requires it and after containing agent access to every old carrier; otherwise roll forward by fixing the new role/grants. Revert the unit drop-in and root cron replacements together, start the previous service, and check `/api/health`, one JWT-authenticated call and every cron. The founder must authorize any live credential reversal or rotation. CI workflows and runs are outside this procedure.

## Synthetic proof

`scripts/smoke/paperclip-db-credential-e2e.sh` runs a disposable PostgreSQL container with one service role, six job roles, a revoked old role and separate OS UIDs. It also checks that a clean worktree passes and a nested copy fails the scanner. It reports assertion counts only. The targeted Vitest cases cover file-source precedence, local/ACPX/SSH/sandbox environment scrubbing and JWT issuance. The container test proves OS-file and DB-auth boundaries; live adapter mount, host runtime service and real job SQL checks remain explicit rollout gates.
