#!/usr/bin/env bash
# Stage reviewed cron code and systemd units. Run on the live host only after
# explicit founder go. This does not enable timers or move/revoke credentials.
set -euo pipefail

check_only=false
if [[ ${1:-} == --check ]]; then
  check_only=true
else
  [[ ${EUID} -eq 0 ]] || { echo 'root required' >&2; exit 1; }
  [[ ${HELA12871_FOUNDER_GO:-} == 1 ]] || { echo 'founder go required' >&2; exit 1; }
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ $check_only == false ]]; then
  # Never execute root staging logic out of an agent-writable worktree.
  [[ $source_dir == /opt/paperclip-cron-release/*/ops/cron-service ]] \
    || { echo 'use a root-owned checkout under /opt/paperclip-cron-release' >&2; exit 1; }
  [[ $(stat -c '%u' "$source_dir") == 0 ]] \
    || { echo 'staging source must be root-owned' >&2; exit 1; }
  [[ -n ${HELA12871_APPROVED_SHA:-} ]] \
    && [[ $(git -C "$source_dir" rev-parse HEAD) == "$HELA12871_APPROVED_SHA" ]] \
    && [[ -z $(git -C "$source_dir" status --porcelain) ]] \
    || { echo 'reviewed commit SHA and clean checkout required' >&2; exit 1; }
fi
host_home=/home/paperclip-user
if [[ $check_only == true ]]; then
  stage_base=${PAPERCLIP_RUN_SCRATCH_DIR:-/var/tmp}
else
  stage_base=/var/tmp
fi
stage=$(mktemp -d "$stage_base/hela12871-cron.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT

# Fail closed if any live host script changed since the reviewed patch was made.
printf '%s  %s\n' \
  '7d4f2ae5f79705e739c96d77ffd19f5b285e46bced6135ae7a86e94f91c03853' "$host_home/agent-watchdog.py" \
  'c4a8807e713bcaf78f17c5ed4a613bc37dff33825428c3804ad6df042c8b0e8b' "$host_home/quota-rewake/quota_rewake.py" \
  'e3cea73f6db6f206b7f91c725991aa5aa8fa4b56255c23c74ace8087da6b5667' "$host_home/helloprint/deploy-frontend.sh" \
  | sha256sum --check --status || { echo 'host sources changed; refresh review' >&2; exit 1; }

cp -- "$host_home/agent-watchdog.py" "$stage/agent-watchdog.py"
cp -- "$host_home/quota-rewake/quota_rewake.py" "$stage/quota_rewake.py"
cp -- "$host_home/helloprint/deploy-frontend.sh" "$stage/deploy-frontend.sh"

# The old scripts contain a DB password literal. Remove it before applying the
# reviewed patches; no secret value enters this repository or patch output.
python3 - "$stage" <<'PY'
from pathlib import Path
import re
import sys
stage = Path(sys.argv[1])
for filename, variable, replacement in (
    ('agent-watchdog.py', 'DSN', "DSN = os.environ['WATCHDOG_PG']"),
    ('quota_rewake.py', 'CONN', "CONN = os.environ['QR_PG']"),
):
    path = stage / filename
    text, count = re.subn(rf'^{variable} = .+$', replacement, path.read_text(), count=1, flags=re.M)
    if count != 1:
        raise SystemExit(f'{filename}: DB config anchor changed')
    path.write_text(text)
PY

patch --batch --fuzz=0 -d "$stage" -p0 < "$source_dir/agent-watchdog.patch"
patch --batch --fuzz=0 -d "$stage" -p0 < "$source_dir/quota_rewake.patch"
patch --batch --fuzz=0 -d "$stage" -p0 < "$source_dir/deploy-frontend.patch"
python3 - "$stage" "$source_dir" <<'PY'
import ast
from pathlib import Path
import sys
stage, source = map(Path, sys.argv[1:])
for path in (stage / 'agent-watchdog.py', stage / 'quota_rewake.py',
             source / 'api_broker.py', source / 'api_client.py'):
    ast.parse(path.read_text(), filename=str(path))
PY
bash -n "$stage/deploy-frontend.sh"

if [[ $check_only == true ]]; then
  echo 'Host sources match reviewed hashes; sanitized patches and syntax checks pass.'
  exit 0
fi

for account in pc-cron-watchdog pc-cron-quota pc-cron-deploy; do
  getent group "$account" >/dev/null || groupadd --system "$account"
  if ! id "$account" >/dev/null 2>&1; then
    useradd --system --gid "$account" --home-dir "/var/lib/$account" \
      --create-home --shell /usr/sbin/nologin "$account"
  fi
  install -d -o "$account" -g "$account" -m 0700 "/var/lib/$account"
done
install -d -o pc-cron-watchdog -g pc-cron-watchdog -m 0700 /var/lib/pc-cron-watchdog/.secrets
install -d -o pc-cron-quota -g pc-cron-quota -m 0700 /var/lib/pc-cron-quota/.secrets
install -d -o pc-cron-quota -g pc-cron-quota -m 0700 /var/lib/pc-cron-quota/quota-rewake
install -d -o root -g root -m 0755 /opt/paperclip-cron
install -d -o root -g root -m 0755 /etc/paperclip-cron
install -o root -g root -m 0755 "$stage/agent-watchdog.py" /opt/paperclip-cron/agent-watchdog.py
install -o root -g root -m 0755 "$stage/quota_rewake.py" /opt/paperclip-cron/quota_rewake.py
install -o root -g root -m 0755 "$source_dir/api_broker.py" /opt/paperclip-cron/api_broker.py
install -o root -g root -m 0755 "$source_dir/api_client.py" /opt/paperclip-cron/api_client.py
install -o root -g root -m 0755 "$stage/deploy-frontend.sh" /opt/paperclip-cron/deploy-frontend.sh.staged
install -o root -g root -m 0644 "$source_dir"/*.service "$source_dir"/*.timer /etc/systemd/system/
systemctl daemon-reload
echo 'Code and units staged. Timers remain disabled; create scoped identities/secrets, run smoke, then cut over.'
