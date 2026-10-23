#!/usr/bin/env bash
# Source from the repository root before running MCP operator examples.
OPERATOR_HTTP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

operator_http() {
  local auth="$1" method="$2" url="$3"
  shift 3
  if [[ $# -gt 0 ]]; then
    local body="$1"
    shift
    printf '%s' "$body" | OPERATOR_HTTP_URL="$url" python3 "$OPERATOR_HTTP_SCRIPT_DIR/operator-http.py" "$method" --auth "$auth" --body-stdin "$@"
  else
    OPERATOR_HTTP_URL="$url" python3 "$OPERATOR_HTTP_SCRIPT_DIR/operator-http.py" "$method" --auth "$auth"
  fi
}

board_api() { operator_http board "$@"; }
gateway_api() { operator_http gateway "$@"; }
