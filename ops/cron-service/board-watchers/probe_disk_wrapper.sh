#!/usr/bin/bash
# Exercise the agent-side disk wrapper with disposable commands and no network.
set -euo pipefail
package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

docker run --rm -i --network none \
  --mount "type=bind,src=$package_dir,dst=/package,readonly" \
  node:24-bookworm-slim sh -s <<'SH'
set -eu
mkdir -p /home/paperclip-user/bin /home/paperclip-user/helloprint-codex /opt/paperclip-cron
cat > /home/paperclip-user/bin/farm-artifact-gc.sh <<'GC'
#!/bin/sh
exit 0
GC
chmod 755 /home/paperclip-user/bin/farm-artifact-gc.sh
cat > /usr/bin/python3 <<'PY'
#!/bin/sh
printf '%s\n' "$*" >> /tmp/python-calls
exit 0
PY
chmod 755 /usr/bin/python3

LOG=/tmp/healthy.log FREE_GB_OVERRIDE=100 ROOT_FREE_OVERRIDE=100 \
  SDB_FREE_OVERRIDE=5 DRY_RUN=1 bash /package/disk-pressure-gc-agent.sh
grep -q '^/opt/paperclip-cron/disk_guard_agent.py --volume sdb ' /tmp/python-calls
! grep -q 'sweeping STALE_DAYS' /tmp/healthy.log
: > /tmp/python-calls

cat > /usr/bin/df <<'DF'
#!/bin/sh
case "$*" in
  *--output=avail*) printf 'Avail\n0G\n' ;;
  *--output=source*) printf 'Filesystem\n%s\n' "${FIXTURE_DEVICE:-/dev/fixture}" ;;
esac
DF
chmod 755 /usr/bin/df

LOG=/tmp/critical.log ROOT_FREE_OVERRIDE=100 SDB_FREE_OVERRIDE=100 \
  DRY_RUN=0 bash /package/disk-pressure-gc-agent.sh
[ "$(grep -c '^/opt/paperclip-cron/disk_client.py escalate$' /tmp/python-calls)" -eq 1 ]
LOG=/tmp/critical.log ROOT_FREE_OVERRIDE=100 SDB_FREE_OVERRIDE=100 \
  DRY_RUN=0 bash /package/disk-pressure-gc-agent.sh
[ "$(grep -c '^/opt/paperclip-cron/disk_client.py escalate$' /tmp/python-calls)" -eq 1 ]

FIXTURE_DEVICE=/dev/second LOG=/tmp/critical.log ROOT_FREE_OVERRIDE=100 \
  SDB_FREE_OVERRIDE=100 DRY_RUN=0 bash /package/disk-pressure-gc-agent.sh
[ "$(grep -c '^/opt/paperclip-cron/disk_client.py escalate$' /tmp/python-calls)" -eq 2 ]
echo 'PASS: healthy farm still checks sdb; one alarm per critical volume per two hours'
SH
