# Safe API Calls and Process Diagnostics

Set `PAPERCLIP_SKILL_DIR` to the absolute path of the `paperclip` skill directory in the same shell as the commands below. The scripts use Python's standard library and the current `PAPERCLIP_*` env vars.

```sh
if test -f skills/paperclip/scripts/paperclip-api.py; then
  # Paperclip repository root
  export PAPERCLIP_SKILL_DIR="$PWD/skills/paperclip"
elif test -f scripts/paperclip-api.py; then
  # Installed paperclip skill root
  export PAPERCLIP_SKILL_DIR="$PWD"
else
  echo 'Paperclip API helper is missing; install the complete skill bundle' >&2
  exit 1
fi
```

Run the API and diagnostic examples from either directory after this setup.

```sh
# API key stays in the client's memory; the JSON body comes from stdin.
python3 "$PAPERCLIP_SKILL_DIR/scripts/paperclip-api.py" GET \
  "/api/issues/$PAPERCLIP_TASK_ID/heartbeat-context"

printf '%s' '{"body":"Progress recorded"}' |
  python3 "$PAPERCLIP_SKILL_DIR/scripts/paperclip-api.py" POST \
    "/api/issues/$PAPERCLIP_TASK_ID/comments" --body-stdin

# Default process view contains executable names, not arguments.
python3 "$PAPERCLIP_SKILL_DIR/scripts/paperclip-processes.py"
```

The process wrapper rejects `--args`: arbitrary token options, including
`--bearer-token=`, can leak a credential if a filter misses them. Never run
unfiltered `ps ... args` or put `Authorization` headers in a `curl -H`
argument on a shared host.

To reproduce the four-layer check with a **synthetic** bearer marker:

```sh
python3 "$PAPERCLIP_SKILL_DIR/scripts/paperclip-safety-probe.py" probe \
  --marker-file "$PAPERCLIP_RUN_SCRATCH_DIR/argv-safety.marker" \
  --live-path "/api/issues/$PAPERCLIP_TASK_ID/heartbeat-context"

# After the first command's tool output has been recorded, select this run's
# raw Codex JSONL session and pass its path (not its contents) here.
python3 "$PAPERCLIP_SKILL_DIR/scripts/paperclip-safety-probe.py" verify \
  --marker-file "$PAPERCLIP_RUN_SCRATCH_DIR/argv-safety.marker" \
  --transcript /path/to/current/rollout.jsonl
```

The probe confirms that a legacy `curl -H` request exposes the synthetic marker
in argv and raw `ps` capture (RED), then confirms that the new client reaches
the mock API without doing so (GREEN). It also places a synthetic bearer token
in a process argument, verifies the safe process view omits it, and verifies
that `--args` is rejected. The live GET checks real Paperclip auth.
The verify command scans the raw transcript and paginated stored run-log without
printing either the marker or any matching line. Keep the marker file only in
the run-owned scratch directory, which Paperclip removes after the run.
