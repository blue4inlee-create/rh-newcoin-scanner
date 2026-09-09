// Preload patch for Google Apps Script ContentService webhooks.
// Apps Script executes the POST, then returns a 302 to script.googleusercontent.com.
// Node fetch follows that redirect as GET, which can surface as a final 404 even though
// the webhook write already succeeded. Keep the redirect manual and acknowledge only
// the known Google ContentService redirect target.

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
      return new Response(JSON.stringify({ ok: true, apps_script_redirect: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  return res;
};
