#!/bin/bash
# Boots the real Paperclip server with a disposable PostgreSQL and file credential.
set -Eeuo pipefail
set +x
trap 'printf "Paperclip server smoke failed at line %s\n" "$LINENO" >&2' ERR
repo_root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
scratch_parent=${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}
scratch=$(mktemp -d "$scratch_parent/paperclip-db-server-e2e.XXXXXX")
container="paperclip-db-e2e-$$"
server_pid=
cleanup() {
  if [ -n "$server_pid" ]; then
    kill -TERM -- "-$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

password=$(openssl rand -hex 16)
cat > "$scratch/postgres.env" <<EOF
POSTGRES_USER=paperclip
POSTGRES_DB=paperclip
POSTGRES_PASSWORD=$password
EOF
chmod 0600 "$scratch/postgres.env"
docker run --rm -d --name "$container" -p 127.0.0.1::5432 \
  --env-file "$scratch/postgres.env" postgres:16 >/dev/null
for ((attempt=1; attempt<=30; attempt++)); do
  if docker exec "$container" pg_isready -U paperclip -d paperclip >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! docker exec "$container" pg_isready -U paperclip -d paperclip >/dev/null 2>&1; then
  docker inspect "$container" --format 'Postgres container state: {{.State.Status}}, exit={{.State.ExitCode}}' >&2 || true
  docker logs "$container" 2>&1 | sed -E -e "s/$password/[REDACTED]/g" -e 's#postgres(ql)?://[^[:space:]]+#postgres://[REDACTED]#g' | tail -12 >&2 || true
  exit 1
fi
db_port=$(docker port "$container" 5432/tcp | sed -n 's/.*://p' | head -1)
[ -n "$db_port" ]
server_port=$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
)
mkdir -p "$scratch/home"
cat > "$scratch/config.json" <<EOF
{"\$meta":{"version":1,"updatedAt":"2026-09-27T00:00:00.000Z","source":"configure"},
 "database":{"mode":"postgres","backup":{"enabled":false}},
 "logging":{"mode":"file","logDir":"$scratch/home/logs"},
 "server":{"deploymentMode":"local_trusted","exposure":"private","host":"127.0.0.1","port":$server_port,"serveUi":false},
 "telemetry":{"enabled":false}}
EOF
printf 'postgres://paperclip:%s@127.0.0.1:%s/paperclip\n' "$password" "$db_port" > "$scratch/database-url"
chmod 0600 "$scratch/database-url"
setsid env -i PATH="$PATH" HOME="$scratch/home" \
  PAPERCLIP_HOME="$scratch/home" PAPERCLIP_CONFIG="$scratch/config.json" \
  PAPERCLIP_DATABASE_URL_FILE="$scratch/database-url" \
  PAPERCLIP_AGENT_JWT_SECRET=synthetic-jwt-signing-key-for-e2e-only \
  PAPERCLIP_MIGRATION_AUTO_APPLY=true PAPERCLIP_MIGRATION_PROMPT=never \
  "$repo_root/server/node_modules/.bin/tsx" "$repo_root/server/src/index.ts" \
  > "$scratch/server.log" 2>&1 &
server_pid=$!
code=000
for ((attempt=1; attempt<=120; attempt++)); do
  code=$(curl -sS --max-time 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$server_port/api/health" 2>/dev/null || true)
  if [ "$code" = 200 ]; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$code" != 200 ]; then
  echo "Paperclip health smoke failed: HTTP $code" >&2
  sed -E -e "s/$password/[REDACTED]/g" -e 's#postgres(ql)?://[^[:space:]]+#postgres://[REDACTED]#g' "$scratch/server.log" | tail -15 >&2
  exit 1
fi
if grep -F "$password" "$scratch/server.log" >/dev/null; then
  echo "Paperclip log contains the synthetic DB password" >&2
  exit 1
fi
echo "Paperclip file-backed DB smoke passed: /api/health HTTP $code, log credential leak 0"
