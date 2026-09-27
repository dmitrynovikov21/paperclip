#!/bin/sh
set -eu
repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
docker run --rm --network none --entrypoint bash \
  --mount "type=bind,src=$repo_root/ops/paperclip-db-credential,dst=/work,readonly" \
  postgres:16 /work/container-e2e.sh
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
cp "$scratch/old-url" "$scratch/worktree/nested/notes.txt"
if python3 "$scan" --old-url-file "$scratch/old-url" --worktree-root "$scratch/worktree" \
  > "$scratch/scan-result"; then
  echo 'Copy scan did not reject a worktree credential copy' >&2
  exit 1
fi
grep -q 'reasons=old-url-copy' "$scratch/scan-result"
echo 'Worktree copy scan assertions passed: clean tree and nested secret copy'
