function resolveAccountAuthUrl(env, metadata) {
  return env.GECHO_ACCOUNT_AUTH_URL || metadata.desktopAccountAuthUrl || null;
}

module.exports = { resolveAccountAuthUrl };
