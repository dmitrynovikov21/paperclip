#!/bin/bash
# Disposable synthetic proof. Never prints a connection string or password.
set -Eeuo pipefail
set +x
pgbin=/usr/lib/postgresql/16/bin
root=$(mktemp -d)
chmod 0755 "$root"
pgdata=$root/pgdata
socket=$root/socket
port=55433
assertions=0
cleanup() {
  runuser -u postgres -- "$pgbin/pg_ctl" -D "$pgdata" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT
trap 'printf "Synthetic e2e failed at line %s\n" "$LINENO" >&2' ERR
mkdir -m 0700 "$pgdata" "$socket"
chown postgres:postgres "$pgdata" "$socket"
touch "$root/postgres.log"
chown postgres:postgres "$root/postgres.log"
runuser -u postgres -- "$pgbin/initdb" -D "$pgdata" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
runuser -u postgres -- "$pgbin/pg_ctl" -D "$pgdata" -o "-h 127.0.0.1 -k $socket -p $port" -l "$root/postgres.log" start >/dev/null
admin() { runuser -u postgres -- psql -h "$socket" -p "$port" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@" >/dev/null; }

admin -c 'CREATE DATABASE synthetic;'
admin -c 'REVOKE ALL ON DATABASE synthetic FROM PUBLIC;'
new_password() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
old_password=$(new_password)
service_password=$(new_password)
admin -c "CREATE ROLE old_agent LOGIN PASSWORD '$old_password'; ALTER ROLE old_agent NOLOGIN;"
admin -c "CREATE ROLE pc_service LOGIN PASSWORD '$service_password'; GRANT CONNECT ON DATABASE synthetic TO pc_service;"
runuser -u postgres -- psql -h "$socket" -p "$port" -U postgres -d synthetic -X -q -v ON_ERROR_STOP=1 -c 'CREATE TABLE protected (id integer); GRANT USAGE ON SCHEMA public TO pc_service; GRANT SELECT ON protected TO pc_service;' >/dev/null

useradd -u 2101 -M -s /usr/sbin/nologin pc-service
useradd -u 2102 -M -s /usr/sbin/nologin pc-agent
mkdir -p "$root/credentials" "$root/worktree/.paperclip"
chmod 0755 "$root" "$root/credentials" "$root/worktree" "$root/worktree/.paperclip"
printf '{"database":{"mode":"postgres"}}\n' > "$root/worktree/.paperclip/config.json"
printf 'PAPERCLIP_INSTANCE_ID=synthetic\n' > "$root/worktree/.paperclip/.env"

make_credential() {
  local user=$1 role=$2 password=$3 directory=$4
  mkdir -m 0700 "$directory"
  printf 'postgres://%s:%s@127.0.0.1:%s/synthetic\n' "$role" "$password" "$port" > "$directory/database-url"
  chmod 0400 "$directory/database-url"
  chown -R "$user:$user" "$directory"
}
make_credential pc-service pc_service "$service_password" "$root/credentials/service"

jobs=(daily fleet watchdog testgc wipcap disk)
for index in "${!jobs[@]}"; do
  job=${jobs[$index]}
  role=pc_job_$((index + 1))
  password=$(new_password)
  user=pcjob-$job
  useradd -u "$((2110 + index))" -M -s /usr/sbin/nologin "$user"
  admin -c "CREATE ROLE $role LOGIN PASSWORD '$password'; GRANT CONNECT ON DATABASE synthetic TO $role;"
  make_credential "$user" "$role" "$password" "$root/credentials/$job"
done

probe() {
  local user=$1 credential=$2 expected=$3
  runuser -u "$user" -- /work/probe-credential.sh "$credential" "$expected" >/dev/null
  assertions=$((assertions + 2))
}
probe pc-service "$root/credentials/service/database-url" pc_service
for index in "${!jobs[@]}"; do
  job=${jobs[$index]}
  probe "pcjob-$job" "$root/credentials/$job/database-url" "pc_job_$((index + 1))"
done

# A distinct agent UID cannot read any service/job credential, including
# through the worktree path; the old password fails even when supplied to it.
for credential in "$root"/credentials/*/database-url; do
  runuser -u pc-agent -- test ! -r "$credential"
  assertions=$((assertions + 1))
done
printf 'postgres://old_agent:%s@127.0.0.1:%s/synthetic\n' "$old_password" "$port" > "$root/old-url"
chmod 0644 "$root/old-url"
if runuser -u pc-agent -- /work/probe-credential.sh "$root/old-url" old_agent >/dev/null 2>&1; then
  exit 1
fi
assertions=$((assertions + 1))
if grep -R -F "$old_password" "$root/worktree" >/dev/null; then exit 1; fi
assertions=$((assertions + 1))
echo "Synthetic DB identity assertions passed: $assertions"
