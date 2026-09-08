#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/smoke/task-watchdog-child-completion.sh [options]

Runs the watchdog child-completion contract through real Express routes and an
isolated embedded PostgreSQL instance. It never launches agent workers.

Options:
  --health-url URL          Also require an explicit test/staging /api/health endpoint to report status=ok.
  --continuity-json FILE    Also require a release continuity report whose lostRunIds array is empty.
  -h, --help                Show this help.

Do not point --health-url at a live business environment. The behavioral smoke
creates its own test company only inside the embedded test database.
EOF
}

health_url=""
continuity_json=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --health-url)
      [[ $# -ge 2 ]] || { echo "--health-url requires a value" >&2; exit 2; }
      health_url="$2"
      shift 2
      ;;
    --continuity-json)
      [[ $# -ge 2 ]] || { echo "--continuity-json requires a value" >&2; exit 2; }
      continuity_json="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "Refusing to run with DATABASE_URL set; this smoke owns an isolated embedded PostgreSQL instance." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
cd "$repo_root"

pnpm exec vitest run \
  server/src/__tests__/task-watchdog-child-completion-e2e.test.ts \
  --reporter=verbose

if [[ -n "$health_url" ]]; then
  [[ "$health_url" == */api/health ]] || {
    echo "--health-url must end in /api/health" >&2
    exit 2
  }
  health_payload="$(curl --fail --silent --show-error --max-time 10 "$health_url")"
  node -e '
    const payload = JSON.parse(process.argv[1]);
    if (payload.status !== "ok") {
      throw new Error(`Expected health status=ok, received ${JSON.stringify(payload)}`);
    }
  ' "$health_payload"
fi

if [[ -n "$continuity_json" ]]; then
  [[ -f "$continuity_json" ]] || {
    echo "Continuity report not found: $continuity_json" >&2
    exit 2
  }
  node -e '
    const fs = require("node:fs");
    const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(payload.lostRunIds) || payload.lostRunIds.length !== 0) {
      throw new Error(`Expected lostRunIds=[], received ${JSON.stringify(payload.lostRunIds)}`);
    }
  ' "$continuity_json"
fi

echo "task-watchdog child-completion smoke: PASS"
