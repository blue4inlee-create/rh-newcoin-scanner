// Preload patch for Google Apps Script ContentService webhooks.
// Adds SQLite-first persistence for discovery events before forwarding to Sheets.
import { persistDiscovery } from './db.mjs';

const nativeFetch = globalThis.fetch.bind(globalThis);
const TRACKED_STAGES = new Set(['Canary', 'Early Alpha', 'Confirmed Alpha', 'Size-up']);
const DISCOVERY_EVENTS = new Set(['TOKEN_DISCOVERED', 'POOL_CREATED']);

async function followAppsScriptRedirect(res) {
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') || '';
    let trustedRedirect = false;
    try {
      trustedRedirect = new URL(location).hostname === 'script.googleusercontent.com';
    } catch {}

    if (trustedRedirect) {
      return nativeFetch(location, {
        method: 'GET',
        redirect: 'follow',
        headers: { accept: 'application/json' },
      });
    }
  }

  return res;
}

async function responseAccepted(res) {
  if (!res.ok) return false;
  try {
    const body = await res.clone().json();
    return body?.ok !== false;
  } catch {
    return true;
  }
}

async function mirrorCanaryTrack(url, init, payload) {
  const stage = String(payload?.new_stage || payload?.stage || '');
  if (String(payload?.event_type || '').toUpperCase() !== 'STAGE_CHANGE') return;
  if (!TRACKED_STAGES.has(stage)) return;

  const mirror = {
    ...payload,
    event_type: 'CANARY_TRACK',
    stage,
  };

  const headers = { ...(init?.headers || {}), 'content-type': 'application/json' };
  const res = await nativeFetch(url, {
    ...(init || {}),
    method: 'POST',
    headers,
    body: JSON.stringify(mirror),
    redirect: 'manual',
  });
  const finalRes = await followAppsScriptRedirect(res);

  if (!(await responseAccepted(finalRes))) {
    const text = await finalRes.text().catch(() => '');
    console.error('[canary-mirror] rejected', finalRes.status, text.slice(0, 300));
  }
}

globalThis.fetch = async function patchedFetch(input, init) {
  const url = typeof input === 'string' ? input : String(input?.url || '');
  const isAppsScriptWebhook = /^https:\/\/script\.google\.com\/macros\/s\//i.test(url);

  if (!isAppsScriptWebhook) return nativeFetch(input, init);

  let payload = null;
  if (typeof init?.body === 'string') {
    try { payload = JSON.parse(init.body); } catch {}
  }

  if (payload && DISCOVERY_EVENTS.has(String(payload.event_type || '').toUpperCase())) {
    const saved = persistDiscovery(payload);
    if (saved?.ok) {
      console.log('[sqlite-first]', payload.event_type, payload.symbol || '', payload.token_ca || '', saved.pool_key || '');
    } else {
      console.error('[sqlite-first] failed', payload.event_type, payload.token_ca || '', saved?.error || 'unknown error');
    }
  }

  const opts = { ...(init || {}), redirect: 'manual' };
  const res = await nativeFetch(input, opts);
  const finalRes = await followAppsScriptRedirect(res);

  if (payload && await responseAccepted(finalRes)) {
    try {
      await mirrorCanaryTrack(url, init, payload);
    } catch (err) {
      console.error('[canary-mirror] error', String(err?.message || err));
    }
  }

  return finalRes;
};
