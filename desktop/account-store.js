const fs = require('node:fs');
const path = require('node:path');

function createAccountStore(dataDir, safeStorage) {
  const file = path.join(dataDir, 'desktop-account.bin');
  function secure() {
    return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }
  return {
    load() {
      if (!secure() || !fs.existsSync(file)) return null;
      try {
        if (fs.statSync(file).size > 65536) return null;
        const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
        return typeof data.refreshToken === 'string' && data.user?.id ? data : null;
      } catch { return null; }
    },
    save(data) {
      if (!secure()) return false;
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = file + '.tmp';
      try {
        fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 });
        fs.renameSync(tmp, file);
        return true;
      } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    },
    clear() { if (fs.existsSync(file)) fs.unlinkSync(file); },
  };
}
module.exports = { createAccountStore };
