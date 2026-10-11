(() => {
  const api = window.gechoDesktop;
  const label = document.getElementById('account-status');
  const login = document.getElementById('account-login');
  const cancel = document.getElementById('account-cancel');
  const logout = document.getElementById('account-logout');
  function render(state) {
    const connected = Boolean(state.user);
    const pending = state.status === 'authorizing';
    const labels = {
      unavailable: '账号授权尚未配置 / Account authorization is not configured',
      signedOut: '未登录 / Signed out',
      authorizing: '请在浏览器确认；若先登录官网，请点击继续授权 / Confirm in browser, then continue',
      refreshing: '正在验证账号 / Checking account',
      reauthRequired: '授权已失效，请重新登录 / Please sign in again',
      signedIn: '已登录 / Signed in',
    };
    label.textContent = labels[state.status] || '登录状态未知 / Unknown account state';
    if (connected) label.textContent += `：${state.user.id}${state.online ? '' : '（离线，尚未验证 / Offline）'}`;
    if (connected && !state.persistent) label.textContent += '；仅本次运行有效 / This session only';
    if (state.error) label.textContent += `；${state.error}`;
    if (state.remoteRevoked === false) label.textContent += '；本地已退出，但无法确认远端撤销 / Remote revocation not confirmed';
    login.classList.toggle('hidden', connected);
    login.disabled = state.status === 'unavailable' || state.status === 'refreshing';
    login.textContent = pending ? '继续授权 / Continue authorization' : '登录 Gecho / Sign in';
    cancel.classList.toggle('hidden', !pending);
    logout.classList.toggle('hidden', !connected);
  }
  async function run(button, operation) {
    button.disabled = true;
    try { render(await operation()); }
    catch { label.textContent = '账号操作失败，请重试 / Account operation failed'; }
    finally { button.disabled = false; }
  }
  login.addEventListener('click', () => run(login, () => api.loginAccount()));
  cancel.addEventListener('click', () => run(cancel, () => api.cancelAccountLogin()));
  logout.addEventListener('click', () => run(logout, () => api.logoutAccount()));
  api.onAccountStatus(render);
  api.getAccountStatus().then(render).catch(() => { label.textContent = '无法读取账号状态 / Cannot read account state'; });
})();
