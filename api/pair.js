const fs = require('fs');
const os = require('os');
const path = require('path');

const sessions = global.__nexusSessions || (global.__nexusSessions = new Map());

async function startPairing(phone) {
  // Dynamic import — Baileys v7 is ESM only, require() doesn't work
  const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
  } = await import('@whiskeysockets/baileys');

  const pino = (await import('pino')).default;

  const id = `${phone}_${Date.now()}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-'));

  const { state, saveCreds } = await useMultiFileAuthState(tmpDir);

  let version;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
  } catch {
    version = [2, 3000, 1015901307];
  }

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    browser: ['NEXUS-MD', 'Chrome', '3.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false
  });

  const pairingCode = await sock.requestPairingCode(phone);

  sessions.set(id, { sock, tmpDir, state: 'pending', sessionString: null, error: null });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    const entry = sessions.get(id);
    if (!entry) return;

    if (connection === 'open') {
      try {
        const credsPath = path.join(tmpDir, 'creds.json');
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        entry.sessionString = 'NEXUS-MD:~' + Buffer.from(JSON.stringify(creds)).toString('base64');
        entry.state = 'ready';
      } catch {
        entry.state = 'error';
        entry.error = 'Failed to read session credentials.';
      }
      try { sock.end(); } catch {}
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (entry.state === 'pending') {
        entry.state = 'error';
        entry.error = code === DisconnectReason.loggedOut
          ? 'Logged out.'
          : 'Connection closed. Try again.';
      }
    }
  });

  setTimeout(() => {
    const entry = sessions.get(id);
    if (entry) {
      try { entry.sock?.end(); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      sessions.delete(id);
    }
  }, 180000);

  return { id, pairingCode };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action') || 'start';

  if (action === 'start') {
    const phone = (url.searchParams.get('phone') || '').replace(/\D/g, '');
    if (!phone || phone.length < 7) {
      res.status(400).json({ error: 'Invalid phone number. Include country code without +.' });
      return;
    }
    try {
      const { id, pairingCode } = await startPairing(phone);
      res.status(200).json({ id, pairingCode });
    } catch (err) {
      console.error('startPairing error:', err.message);
      res.status(500).json({ error: err.message || 'Failed to start pairing.' });
    }
    return;
  }

  if (action === 'status') {
    const id = url.searchParams.get('id') || '';
    const entry = sessions.get(id);
    if (!entry) { res.status(200).json({ status: 'expired' }); return; }
    res.status(200).json({
      status: entry.state,
      sessionString: entry.sessionString || null,
      error: entry.error || null
    });
    return;
  }

  res.status(400).json({ error: 'Unknown action.' });
};
