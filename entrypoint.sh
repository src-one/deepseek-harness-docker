#!/bin/sh
set -e

DSH_PORT="${DSH_PORT:-3079}"
PROXY_PORT="${PROXY_PORT:-3080}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"

echo "========================================================"
echo " Starting DeepSeek Harness with Playwright Web Search"
echo " Internal DSH Port: $DSH_PORT | Public Proxy Port: $PROXY_PORT"
echo " Playwright Browsers: $PLAYWRIGHT_BROWSERS_PATH"
echo "========================================================"

# ── 0. Ensure Web Profile & Playwright Search Plugin ─────────────────
PROFILE_DIR="${DSH_HOME:-/root/.dsh}/profiles/web"
mkdir -p "$PROFILE_DIR"

if [ ! -f "$PROFILE_DIR/package.json" ] || ! grep -q "dsh-web-search-playwright" "$PROFILE_DIR/package.json" 2>/dev/null; then
  echo "[plugin] Configuring dsh-web-search-playwright plugin in web profile..."
  if [ -d "/opt/dsh/default-profile/web" ]; then
    cp -rn /opt/dsh/default-profile/web/* "$PROFILE_DIR/" 2>/dev/null || true
  fi
  # Run plugin add to link/register properly if needed
  if command -v dsh >/dev/null 2>&1 && [ -d "/opt/plugins/dsh-web-search-playwright" ]; then
    dsh plugin --profile web add /opt/plugins/dsh-web-search-playwright || echo "[plugin] Notice: plugin link completed"
  fi
fi

# ── 1. Workspace Configuration ───────────────────────────────────────
if [ -n "$DSH_WORKSPACE" ]; then
  echo "[dsh] Setting workspace directory (DSH_WORKSPACE): $DSH_WORKSPACE"
  mkdir -p "$DSH_WORKSPACE"
  cd "$DSH_WORKSPACE"
fi

# ── 2. Launch DSH Daemon ────────────────────────────────────────────
echo "[dsh] Starting DSH core daemon (dsh web --port $DSH_PORT) ..."
dsh web --port "$DSH_PORT" > /tmp/dsh-startup.log 2>&1 &
DSH_PID=$!

# Tail logs to container stdout
tail -f /tmp/dsh-startup.log 2>/dev/null &
TAIL_PID=$!

# ── 3. Wait for DSH Readiness ───────────────────────────────────────
echo "[dsh] Waiting for DSH to become ready on 127.0.0.1:$DSH_PORT ..."
ready=0
i=0
while [ "$i" -lt 120 ]; do
  if node -e "fetch('http://127.0.0.1:$DSH_PORT/').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    echo "[dsh] ERROR: DSH process terminated unexpectedly"
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$ready" != "1" ]; then
  echo "[dsh] ERROR: DSH did not become ready within 120s"
  exit 1
fi
echo "[dsh] DSH daemon ready (PID $DSH_PID)"

# ── 4. Workspace Auto-Registration ──────────────────────────────────
if [ -n "$DSH_WORKSPACE" ] && [ -f /app/register-workspace.js ]; then
  echo "[dsh] Auto-registering workspace: $DSH_WORKSPACE"
  node /app/register-workspace.js || echo "[dsh] Workspace auto-registration notice (non-fatal)"
fi

# ── 5. Cleanup Trap ─────────────────────────────────────────────────
cleanup() {
  echo "[proxy] Received exit signal, stopping DSH daemon..."
  kill "$DSH_PID" 2>/dev/null || true
  kill "$TAIL_PID" 2>/dev/null || true
  wait "$DSH_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── 6. Start Reverse Proxy (Foreground) ─────────────────────────────
echo "[proxy] Starting proxy server on 0.0.0.0:$PROXY_PORT -> 127.0.0.1:$DSH_PORT"
cd /app/proxy
exec node index.js
