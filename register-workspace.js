#!/usr/bin/env node
const fs = require('fs');

const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const DSH_WORKSPACE = process.env.DSH_WORKSPACE || '';
const DSH_LOG = process.env.DSH_LOG_FILE || '/tmp/dsh-startup.log';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Extract launch token from DSH startup log (if needed for API auth)
async function waitForToken(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const log = fs.readFileSync(DSH_LOG, 'utf8');
      const m = /\?token=([A-Za-z0-9_-]+)/.exec(log) || /\btoken=([A-Za-z0-9_-]+)/.exec(log);
      if (m) return m[1];
    } catch {}
    await sleep(250);
  }
  return null;
}

async function main() {
  if (!DSH_WORKSPACE) {
    console.log('[workspace] DSH_WORKSPACE not set, skipping auto-registration');
    return;
  }
  const base = `http://127.0.0.1:${DSH_PORT}`;
  try {
    let result = await callCreate(base, undefined);
    if (result === 'need-auth') {
      const token = await waitForToken();
      if (!token) {
        console.warn('[workspace] DSH launch token not found in logs, skipping workspace auto-registration');
        return;
      }
      const authRes = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
      const setCookie = authRes.headers.get('set-cookie');
      if (!setCookie) {
        console.warn('[workspace] Failed to get session cookie, skipping workspace auto-registration');
        return;
      }
      result = await callCreate(base, setCookie.split(';')[0]);
    }
    if (result.ok === true) {
      const created = result.value && result.value.created === true;
      console.log(`[workspace] Workspace registered: ${DSH_WORKSPACE}${created ? ' (created)' : ' (reused)'}`);
    } else {
      console.warn(`[workspace] Workspace registration status: ${result.error || 'ok'}`);
    }
  } catch (e) {
    console.warn(`[workspace] Workspace auto-registration notice: ${e.message}`);
  }
}

async function callCreate(base, cookie) {
  const headers = { 'content-type': 'application/json' };
  if (cookie !== undefined) headers.cookie = cookie;
  const res = await fetch(`${base}/api/workspace.create`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `workspace-${Date.now()}`,
      method: 'workspace.create',
      payload: { path: DSH_WORKSPACE },
    }),
  });
  if (res.status === 401) return 'need-auth';
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  const result = body && body.result;
  if (res.ok && result && result.ok === true) return result;
  return {
    ok: false,
    error: (result && result.error && result.error.message) || text || `HTTP ${res.status}`,
  };
}

main();
