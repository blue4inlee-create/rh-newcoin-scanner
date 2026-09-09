// Preload patch for Google Apps Script ContentService webhooks.
// Apps Script executes the POST, then returns a 302 to script.googleusercontent.com.
// Node fetch can mishandle that redirect for POST requests. Keep the POST redirect manual,
// then explicitly GET the trusted ContentService Location so the scanner receives the real
// JSON response, including any { ok:false } error returned by Apps Script.
//
// Production redundancy: after a successful STAGE_CHANGE into a tracked alpha stage,
// mirror the same payload as CANARY_TRACK. Apps Script already attempts this internally,
// but the explicit mirror makes Canary tracking resilient and remains CA-deduped.

const nativeFetch = globalThis.fetch.bind(globalThis);
const TRACKED_STAGES = new Set(['Canary', 'Early Alpha', 'Confirmed Alpha', 'Size-up']);

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
