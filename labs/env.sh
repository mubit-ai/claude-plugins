# labs/env.sh — source this from the repo root:   source labs/env.sh
#
# Everything the plugin reads is set here explicitly, exactly as Claude Code would set it
# for a real install. Nothing leaks in from your shell, and nothing here touches your real
# ~/.claude data directory.

if [ -f "$PWD/labs/env.sh" ]; then
  LAB_REPO_ROOT="$PWD"
elif [ -f "$PWD/env.sh" ] && [ -d "$PWD/../integrations" ]; then
  LAB_REPO_ROOT="$(cd "$PWD/.." && pwd)"
else
  echo "source this from the repo root:  source labs/env.sh" >&2
  return 1 2>/dev/null || exit 1
fi

export LAB_ROOT="$LAB_REPO_ROOT/labs"

# --- what Claude Code exports for a plugin ---------------------------------------------
export CLAUDE_PLUGIN_ROOT="$LAB_REPO_ROOT/integrations/claude-code"
export CLAUDE_PLUGIN_DATA="$LAB_ROOT/.work/data"
export CLAUDE_PROJECT_DIR="$LAB_ROOT/.work/demo-app"

# --- what the plugin itself reads (§6.1) -----------------------------------------------
export MUBIT_CC_DATA_DIR="$CLAUDE_PLUGIN_DATA"
export MUBIT_ENDPOINT="http://127.0.0.1:${LAB_PORT:-8787}"
export MUBIT_API_KEY="mbt_lab_0123456789abcdef0123456789abcdef"
export MUBIT_CC_LOG_LEVEL="debug"
# The MCP server's poisoned default. Blanked so nothing can inherit it (§4.3).
export MUBIT_DEFAULT_SESSION_ID=""

export HOOKS="$CLAUDE_PLUGIN_ROOT/hooks/src"
export PAYLOADS="$LAB_ROOT/payloads"

# ---------------------------------------------------------------------------------------
# hook <name> <payload.json> [args...]
#
# Runs a hook exactly the way Claude Code does: a fresh node process, the payload on
# stdin, JSON on stdout. Prints stdout, then the exit code — which is 0 in every mode,
# including every failure mode.
# ---------------------------------------------------------------------------------------
hook() {
  local name="$1"; shift
  local payload="$1"; shift
  local file="$PAYLOADS/$payload"
  [ -f "$file" ] || { echo "no such payload: $file" >&2; return 1; }
  echo "--- $name  <  $payload  $* ---"
  node "$HOOKS/$name.mjs" "$@" < "$file"
  local code=$?
  echo ""
  echo "--- exit $code ---"
}

# peek [section] — what the hooks left on disk. `peek --help` lists the sections.
peek() { node "$LAB_ROOT/peek.mjs" "$@"; }

# runid ['<payload json>'] — the run id these settings derive, without running a hook.
runid() { node "$LAB_ROOT/runid.mjs" "$@"; }

echo "lab ready"
echo "  endpoint     $MUBIT_ENDPOINT"
echo "  project      $CLAUDE_PROJECT_DIR"
echo "  data dir     $MUBIT_CC_DATA_DIR"
echo "  helpers      hook <name> <payload.json> [args]   peek [section]   runid"
