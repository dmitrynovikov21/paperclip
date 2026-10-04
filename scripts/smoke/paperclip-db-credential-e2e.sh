#!/bin/sh
set -eu
repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
docker build -q -f "$repo_root/ops/paperclip-db-credential/Dockerfile.e2e" \
  -t paperclip-db-credential-e2e:local "$repo_root/ops/paperclip-db-credential" >/dev/null
docker run --rm --network none --entrypoint bash \
  --mount "type=bind,src=$repo_root/ops/paperclip-db-credential,dst=/work,readonly" \
  paperclip-db-credential-e2e:local /work/container-e2e.sh
scratch_parent=${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}
scratch=$(mktemp -d "$scratch_parent/paperclip-copy-scan.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/worktree/.paperclip" "$scratch/worktree/nested"
printf '%s\n' 'postgres://old_agent:synthetic@127.0.0.1/synthetic' > "$scratch/old-url"
printf '%s\n' '{"database":{"mode":"postgres"}}' > "$scratch/worktree/.paperclip/config.json"
printf '%s\n' 'PAPERCLIP_INSTANCE_ID=synthetic' > "$scratch/worktree/.paperclip/.env"
printf '%s\n' 'no credential here' > "$scratch/worktree/nested/notes.txt"
scan="$repo_root/ops/paperclip-db-credential/verify-copies.py"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree"
printf '%s\n' 'postgres://new_agent:different_synthetic@127.0.0.1/synthetic' \
  > "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a new worktree credential' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
grep -Eq 'Copy scan: checked=[0-9]+ failures=[1-9][0-9]*' "$scratch/scan-result"
printf '%s\n' 'postgres://new_agent:synthetic_postgres://suffix@127.0.0.1/synthetic' \
  > "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a credential containing a URL prefix' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
printf '%s\n' 'postgres://a@127.0.0.1/db?application_name=ok;postgres://b@127.0.0.1/db?password=different_synthetic' \
  > "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a password in an adjacent URL' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
printf '%s\n' 'postgres://a@127.0.0.1/db?application_name=postgres://b&password=different_synthetic' \
  > "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a password after a nested URL prefix' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
printf '%s\n' 'postgres://a@127.0.0.1/db?application_name=ok;postgres://b@127.0.0.1/db?application_name=ok' \
  > "$scratch/worktree/nested/notes.txt"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
printf '%s\n' 'postgres://a@127.0.0.1/db?application_name=run?password=disabled' \
  > "$scratch/worktree/nested/notes.txt"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
printf '%s\n' 'no credential here' > "$scratch/worktree/nested/notes.txt"
printf '%s\n' 'DATABASE_URL=postgresql://new_agent:different_synthetic@127.0.0.1/synthetic' \
  > "$scratch/worktree/.env.local"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a new .env.local credential' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
grep -Eq 'Copy scan: checked=[0-9]+ failures=[1-9][0-9]*' "$scratch/scan-result"
rm "$scratch/worktree/.env.local"
printf '%s\n' 'postgresql://new_agent@127.0.0.1/synthetic?application_name=copy_scan' \
  > "$scratch/worktree/nested/notes.txt"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
printf '%s\n' 'DATABASE_URL=postgresql://new_agent@127.0.0.1/synthetic?application_name=copy_scan&password=different_synthetic' \
  > "$scratch/worktree/.env.local"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a query-parameter password in .env.local' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
grep -Eq 'Copy scan: checked=[0-9]+ failures=[1-9][0-9]*' "$scratch/scan-result"
rm "$scratch/worktree/.env.local"
printf '%s\n' 'DATABASE_URL=postgresql://new_agent@127.0.0.1/synthetic' \
  'PGPASSWORD=different_synthetic' \
  > "$scratch/worktree/.env.local"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject PGPASSWORD in .env.local' >&2
  exit 1
fi
grep -q 'env-libpq-password' "$scratch/scan-result"
if grep -q 'different_synthetic' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
rm "$scratch/worktree/.env.local"
printf '%s\n' 'PGPASSFILE=/synthetic/private/passfile' \
  > "$scratch/worktree/.env.local"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a libpq passfile reference in .env.local' >&2
  exit 1
fi
grep -q 'reasons=env-libpq-credential-reference' "$scratch/scan-result"
rm "$scratch/worktree/.env.local"
for fixture in conninfo conninfo_multiline conninfo_password_only \
  conninfo_client_encoding conninfo_client_encoding_multiline shell shell_ansi_c; do
  case "$fixture" in
    conninfo)
      name=conninfo.txt
      content='host=127.0.0.1 dbname=synthetic user=new_agent password=different_synthetic'
      reason=libpq-conninfo-password
      ;;
    conninfo_multiline)
      name=multiline-conninfo.txt
      content='host=127.0.0.1 dbname=synthetic user=new_agent
password=different_synthetic'
      reason=libpq-conninfo-password
      ;;
    conninfo_password_only)
      name=password-only-conninfo.txt
      content='password=different_synthetic'
      reason=libpq-conninfo-password
      ;;
    conninfo_client_encoding)
      name=client-encoding-conninfo.txt
      content='client_encoding=UTF8 host=127.0.0.1 password=different_synthetic'
      reason=libpq-conninfo-password
      ;;
    conninfo_client_encoding_multiline)
      name=client-encoding-multiline-conninfo.txt
      content='client_encoding=UTF8
password=different_synthetic'
      reason=libpq-conninfo-password
      ;;
    shell)
      name=run.sh
      content='export PGPASSWORD=different_synthetic'
      reason=env-libpq-password
      ;;
    shell_ansi_c)
      name=run-ansi-c.sh
      content="export PGPASSWORD=\$'different_synthetic'"
      reason=env-libpq-password
      ;;
  esac
  printf '%s\n' "$content" > "$scratch/worktree/nested/$name"
  chmod 0600 "$scratch/worktree/nested/$name"
  if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
    > "$scratch/scan-result" 2>&1; then
    echo "Copy scan did not reject worktree $fixture credential" >&2
    exit 1
  fi
  grep -q "reasons=$reason" "$scratch/scan-result"
  if grep -q 'different_synthetic' "$scratch/scan-result"; then
    echo 'Copy scan printed synthetic credential material' >&2
    exit 1
  fi
  mv "$scratch/worktree/nested/$name" "$scratch/$name"
  if python3 "$scan" --old-url-file "$scratch/old-url" --carrier "$scratch/$name" \
    > "$scratch/scan-result" 2>&1; then
    echo "Copy scan did not reject explicit $fixture carrier" >&2
    exit 1
  fi
  grep -q "reasons=$reason" "$scratch/scan-result"
  if grep -q 'different_synthetic' "$scratch/scan-result"; then
    echo 'Copy scan printed synthetic credential material' >&2
    exit 1
  fi
  rm "$scratch/$name"
done
printf '%s\n' 'client_encoding=UTF8 host=127.0.0.1 dbname=synthetic user=new_agent' \
  > "$scratch/worktree/nested/clean-conninfo.txt"
printf '%s\n' '#!/bin/sh' 'export PGAPPNAME=synthetic' 'export PGPASSWORD=$FROM_PRIVATE_SOURCE' \
  > "$scratch/worktree/nested/clean-run.sh"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
for name in clean-conninfo.txt clean-run.sh; do
  python3 "$scan" --old-url-file "$scratch/old-url" \
    --carrier "$scratch/worktree/nested/$name" > "$scratch/scan-result"
done
rm "$scratch/worktree/nested/clean-conninfo.txt" "$scratch/worktree/nested/clean-run.sh"
printf '%s\n' 'region:2024:metric:dimension:value' > "$scratch/worktree/nested/metrics.txt"
chmod 0644 "$scratch/worktree/nested/metrics.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not fail closed on an ambiguous five-field record' >&2
  exit 1
fi
grep -q 'reasons=libpq-passfile-entry' "$scratch/scan-result"
rm "$scratch/worktree/nested/metrics.txt"
for service_file in pg_service.conf .pg_service.conf; do
  printf '[synthetic]\nhost=127.0.0.1\npassword=different_synthetic\n' \
    > "$scratch/worktree/$service_file"
  if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
    > "$scratch/scan-result"; then
    echo "Copy scan did not reject $service_file password" >&2
    exit 1
  fi
  grep -q 'reasons=libpq-service-credential' "$scratch/scan-result"
  rm "$scratch/worktree/$service_file"
done
printf '[synthetic]\nhost=127.0.0.1\npassword=different_synthetic\n' \
  > "$scratch/worktree/custom-service.ini"
chmod 0600 "$scratch/worktree/custom-service.ini"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result" 2>&1; then
  echo 'Copy scan did not reject a custom-named worktree service file' >&2
  exit 1
fi
grep -q 'reasons=libpq-service-credential' "$scratch/scan-result"
if grep -q 'different_synthetic' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
mv "$scratch/worktree/custom-service.ini" "$scratch/custom-service.ini"
printf '[synthetic]\npassfile=/synthetic/private/passfile\n' \
  > "$scratch/custom-service.ini"
if python3 "$scan" --old-url-file "$scratch/old-url" --carrier "$scratch/custom-service.ini" \
  > "$scratch/scan-result" 2>&1; then
  echo 'Copy scan did not reject an explicit custom-named service file' >&2
  exit 1
fi
grep -q 'reasons=libpq-service-credential' "$scratch/scan-result"
if grep -q '/synthetic/private/passfile' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
printf '[synthetic]\nhost=127.0.0.1\nuser=new_agent\n' \
  > "$scratch/custom-service.ini"
python3 "$scan" --old-url-file "$scratch/old-url" --carrier "$scratch/custom-service.ini" \
  > "$scratch/scan-result"
rm "$scratch/custom-service.ini"
printf '%s\n' '127.0.0.1:5432:synthetic:new_agent:different_synthetic' \
  > "$scratch/worktree/credentials"
chmod 0600 "$scratch/worktree/credentials"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a custom-named worktree passfile' >&2
  exit 1
fi
grep -q 'reasons=libpq-passfile-entry' "$scratch/scan-result"
if grep -q 'different_synthetic' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
mv "$scratch/worktree/credentials" "$scratch/custom-passfile"
printf '%s\n' '*:*:*:new_agent:different\:synthetic' > "$scratch/custom-passfile"
if python3 "$scan" --old-url-file "$scratch/old-url" --carrier "$scratch/custom-passfile" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject an explicit custom-named passfile' >&2
  exit 1
fi
grep -q 'reasons=libpq-passfile-entry' "$scratch/scan-result"
if grep -q 'different' "$scratch/scan-result"; then
  echo 'Copy scan printed synthetic credential material' >&2
  exit 1
fi
rm "$scratch/custom-passfile"
printf '%s\n' 'host:notaport:db:user:harmless' > "$scratch/custom-carrier"
python3 "$scan" --old-url-file "$scratch/old-url" --carrier "$scratch/custom-carrier" \
  > "$scratch/scan-result"
rm "$scratch/custom-carrier"
printf '[synthetic]\npassfile=/synthetic/private/passfile\n' \
  > "$scratch/worktree/pg_service.conf"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a libpq passfile reference in a service file' >&2
  exit 1
fi
grep -q 'reasons=libpq-service-credential' "$scratch/scan-result"
rm "$scratch/worktree/pg_service.conf"
for passfile in .pgpass pgpass.conf; do
  printf '%s\n' '127.0.0.1:5432:synthetic:new_agent:different_synthetic' \
    > "$scratch/worktree/$passfile"
  chmod 0600 "$scratch/worktree/$passfile"
  if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
    > "$scratch/scan-result"; then
    echo "Copy scan did not reject $passfile credential" >&2
    exit 1
  fi
  grep -q 'reasons=libpq-passfile-entry' "$scratch/scan-result"
  if grep -q 'different_synthetic' "$scratch/scan-result"; then
    echo 'Copy scan printed synthetic credential material' >&2
    exit 1
  fi
  rm "$scratch/worktree/$passfile"
done
printf '%s\n' 'PGAPPNAME=synthetic' > "$scratch/worktree/.env.local"
printf '[synthetic]\nhost=127.0.0.1\nuser=new_agent\n' \
  > "$scratch/worktree/pg_service.conf"
printf '%s\n' '# no credential entry' > "$scratch/worktree/.pgpass"
chmod 0600 "$scratch/worktree/.pgpass"
python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"
rm "$scratch/worktree/.env.local" "$scratch/worktree/pg_service.conf" "$scratch/worktree/.pgpass"
printf '%s\n' 'postgres://new_agent@127.0.0.1/synthetic?pass%77ord=different_synthetic' \
  > "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a percent-encoded query-parameter password' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
printf '%s\n' 'no credential here' > "$scratch/worktree/nested/notes.txt"
# Place the URL prefix across the 1 MiB read boundary and the @ after a
# password longer than one chunk; neither split may bypass the scanner.
head -c 1048570 /dev/zero > "$scratch/worktree/nested/large.bin"
printf 'postgres://new_agent:' >> "$scratch/worktree/nested/large.bin"
head -c 1048580 /dev/zero | tr '\000' 'x' >> "$scratch/worktree/nested/large.bin"
printf '@127.0.0.1/synthetic\n' >> "$scratch/worktree/nested/large.bin"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a chunk-spanning worktree credential' >&2
  exit 1
fi
grep -q 'reasons=inline-db-credential' "$scratch/scan-result"
rm "$scratch/worktree/nested/large.bin"
cp "$scratch/old-url" "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a worktree credential copy' >&2
  exit 1
fi
grep -q 'reasons=old-url-copy' "$scratch/scan-result"
mv "$scratch/worktree/nested/notes.txt" "$scratch/outside-secret"
ln -s "$scratch/outside-secret" "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject an agent-readable symlink to an external credential copy' >&2
  exit 1
fi
grep -q '^SYMLINK ' "$scratch/scan-result"
rm "$scratch/worktree/nested/notes.txt"
ln -s "$scratch" "$scratch/worktree/nested/external-directory"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a symlinked directory outside the worktree' >&2
  exit 1
fi
grep -q '^SYMLINK ' "$scratch/scan-result"
echo 'Worktree copy scan assertions passed: clean tree, new DSN, nested-prefix password, .env.local, libpq env/service/passfile, conninfo (including client_encoding) and shell (including ANSI-C literal) password in worktree and explicit carrier, custom service and passfile in worktree and explicit carrier, ambiguous five-field record fail closed, safe libpq carriers, query password, encoded query key, adjacent URL, nested query URL, clean adjacent URLs, literal query ?, chunk-spanning DSN, old copy, external file symlink, external directory symlink'
