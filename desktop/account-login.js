const http = require('node:http');
const crypto = require('node:crypto');

function createAccountClient({ baseUrl, openExternal, store, onChange = () => {}, timeoutMs = 300000 }) {
  const base = new URL(baseUrl);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && base.hostname === '127.0.0.1'))
      || base.username || base.password || base.search || base.hash) throw new Error('INVALID_AUTH_CONFIGURATION');
  const root = base.href.replace(/\/$/, '');
  let state = { status: 'signedOut', user: null, online: false, persistent: false };
  let session = null, pending = null, epoch = 0, refreshing = null;
  const status = () => structuredClone(state);
  function emit(patch) { state = { ...state, ...patch }; onChange(status()); return status(); }
  async function request(route, body, access) {
    let res;
    try {
      res = await fetch(root + route, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(access ? { Authorization: `Bearer ${access}` } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    } catch { throw new Error('NETWORK_ERROR'); }
    let raw = '', length = 0;
    for await (const chunk of res.body) {
      length += chunk.length;
      if (length > 65536) throw new Error('INVALID_RESPONSE');
      raw += Buffer.from(chunk).toString('utf8');
    }
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('INVALID_RESPONSE'); }
    if (!res.ok) throw new Error(res.status === 401 || data.error === 'invalid_grant' ? 'REAUTH_REQUIRED' : 'AUTH_SERVICE_ERROR');
    return data;
  }
  function closePending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.server.close();
    pending = null;
  }
  function cancel() {
    epoch += 1; closePending();
    return emit({ status: session ? 'signedIn' : 'signedOut', error: null });
  }
  function saveSession(tokens, user) {
    session = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, user,
      expires: Date.now() + tokens.expires_in * 1000 };
    let persistent = false;
    try { persistent = store.save({ refreshToken: session.refreshToken, user: session.user, issuer: root }); } catch {}
    if (!persistent) { try { store.clear(); } catch {} }
    return persistent;
  }
  async function accept(tokens, generation, previousUser = null) {
    if (!tokens || typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string'
        || tokens.access_token.length > 4096 || tokens.refresh_token.length > 4096
        || tokens.token_type !== 'Bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error('INVALID_RESPONSE');
    if (generation !== epoch) {
      await request('/revoke', { token: tokens.refresh_token }).catch(() => {});
      return false;
    }
    // Rotation already invalidated the old token: retain replacement before optional identity I/O.
    if (previousUser) state.persistent = saveSession(tokens, previousUser);
    let user;
    try { user = await request('/me', null, tokens.access_token); }
    catch (error) {
      if (!previousUser) await request('/revoke', { token: tokens.refresh_token }).catch(() => {});
      throw error;
    }
    if (!user || typeof user.id !== 'string' || !user.id || user.id.length > 256) throw new Error('INVALID_RESPONSE');
    if (previousUser && user.id !== previousUser.id) throw new Error('REAUTH_REQUIRED');
    if (generation !== epoch) {
      await request('/revoke', { token: tokens.refresh_token }).catch(() => {});
      return false;
    }
    const persistent = saveSession(tokens, { id: user.id });
    emit({ status: 'signedIn', user: session.user, online: true, persistent, error: null });
    return true;
  }
  async function login() {
    if (pending) {
      await openExternal(pending.url);
      return status();
    }
    if (session) return status();
    const generation = ++epoch;
    const verifier = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const server = http.createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      let callback;
      try { callback = new URL(req.url, 'http://127.0.0.1'); }
      catch { res.writeHead(400); res.end('Invalid callback'); return; }
      if (!pending || pending.busy || req.method !== 'GET' || callback.pathname !== '/callback'
          || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== nonce
          || callback.searchParams.getAll('code').length > 1 || callback.searchParams.getAll('error').length > 1) {
        res.writeHead(400); res.end('Invalid authorization callback'); return;
      }
      pending.busy = true;
      const redirect = pending.redirect;
      try {
        if (callback.searchParams.has('error')) throw new Error('AUTHORIZATION_DENIED');
        const code = callback.searchParams.get('code');
        if (!code || code.length > 2048) throw new Error('INVALID_RESPONSE');
        const tokens = await request('/token', { grant_type: 'authorization_code', client_id: 'gecho-desktop',
          redirect_uri: redirect, code, code_verifier: verifier });
        if (!(await accept(tokens, generation))) throw new Error('AUTHORIZATION_CANCELLED');
        res.end('授权成功，可以回到 Gecho 桌面端。');
      } catch (error) {
        if (generation === epoch) emit({ status: 'signedOut', user: null, online: false, error: error.message });
        res.writeHead(400); res.end('授权未完成，请回到桌面端重试。');
      } finally { if (generation === epoch) closePending(); }
    });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const redirect = `http://127.0.0.1:${server.address().port}/callback`;
      const url = new URL(root + '/authorize');
      url.search = new URLSearchParams({ client_id: 'gecho-desktop', response_type: 'code', redirect_uri: redirect,
        state: nonce, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      if (generation !== epoch) { server.close(); return status(); }
      pending = { server, redirect, url: url.href, busy: false,
        timer: setTimeout(() => { cancel(); emit({ error: 'AUTHORIZATION_TIMEOUT' }); }, timeoutMs) };
      emit({ status: 'authorizing', error: null });
      await openExternal(url.href);
      return status();
    } catch {
      server.close();
      if (generation === epoch) { closePending(); emit({ status: 'signedOut', error: 'BROWSER_OR_CALLBACK_UNAVAILABLE' }); }
      return status();
    }
  }
  async function refresh() {
    if (refreshing) return refreshing;
    if (!session) throw new Error('REAUTH_REQUIRED');
    const generation = epoch, token = session.refreshToken, previousUser = session.user;
    const operation = (async () => {
      emit({ status: 'refreshing' });
      try {
        const tokens = await request('/token', { grant_type: 'refresh_token', client_id: 'gecho-desktop', refresh_token: token });
        await accept(tokens, generation, previousUser);
      } catch (error) {
        if (generation !== epoch) return;
        if (error.message === 'REAUTH_REQUIRED') {
          session = null;
          try { store.clear(); } catch {}
          emit({ status: 'reauthRequired', user: null, online: false, error: error.message });
        } else emit({ status: 'signedIn', online: false, error: error.message });
        throw error;
      }
    })();
    refreshing = operation;
    try { await operation; } finally { if (refreshing === operation) refreshing = null; }
  }
  async function restore() {
    const saved = store.load();
    if (!saved || saved.issuer !== root) return status();
    session = { refreshToken: saved.refreshToken, user: saved.user, expires: 0 };
    emit({ user: saved.user, persistent: true });
    await refresh().catch(() => {});
    return status();
  }
  async function accessToken() {
    if (!session || !session.accessToken || session.expires < Date.now() + 60000) await refresh();
    if (!session?.accessToken) throw new Error('REAUTH_REQUIRED');
    return session.accessToken; // Main-process consumers only; never IPC.
  }
  async function logout() {
    const token = session?.refreshToken;
    cancel(); session = null; refreshing = null;
    let storageError = null;
    try { store.clear(); } catch { storageError = 'CREDENTIAL_REMOVAL_FAILED'; }
    emit({ status: 'signedOut', user: null, persistent: false, online: false, error: storageError });
    let remoteRevoked = true;
    if (token) await request('/revoke', { token }).catch(() => { remoteRevoked = false; });
    return { ...status(), remoteRevoked };
  }
  return { status, login, cancel, restore, logout, accessToken };
}
module.exports = { createAccountClient };
