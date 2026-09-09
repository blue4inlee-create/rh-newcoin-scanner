// Preload patch for Google Apps Script ContentService webhooks.
// Apps Script executes the POST, then returns a 302 to script.googleusercontent.com.
// Node fetch can mishandle that redirect for POST requests. Keep the POST redirect manual,
// then explicitly GET the trusted ContentService Location so the scanner receives the real
// JSON response, including any { ok:false } error returned by Apps Script.

const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async function patchedFetch(input, init) {
  const url = typeof input === 'string' ? input : String(input?.url || '');
  const isAppsScriptWebhook = /^https:\/\/script\.google\.com\/macros\/s\//i.test(url);

  if (!isAppsScriptWebhook) return nativeFetch(input, init);

  const opts = { ...(init || {}), redirect: 'manual' };
  const res = await nativeFetch(input, opts);

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
};
