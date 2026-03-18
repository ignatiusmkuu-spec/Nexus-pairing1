const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = global.__nexusSessions || (global.__nexusSessions = new Map());

async function startPairing(phone) {
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
        entry.error = code === DisconnectReason.loggedOut ? 'Logged out.' : 'Connection closed. Try again.';
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

app.get('/api/pair', async (req, res) => {
  const action = req.query.action || 'start';

  if (action === 'start') {
    const phone = (req.query.phone || '').replace(/\D/g, '');
    if (!phone || phone.length < 7) {
      return res.status(400).json({ error: 'Invalid phone number. Include country code without +.' });
    }
    try {
      const { id, pairingCode } = await startPairing(phone);
      return res.json({ id, pairingCode });
    } catch (err) {
      console.error('startPairing error:', err.message);
      return res.status(500).json({ error: err.message || 'Failed to start pairing.' });
    }
  }

  if (action === 'status') {
    const id = req.query.id || '';
    const entry = sessions.get(id);
    if (!entry) return res.json({ status: 'expired' });
    return res.json({
      status: entry.state,
      sessionString: entry.sessionString || null,
      error: entry.error || null
    });
  }

  return res.status(400).json({ error: 'Unknown action.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`NEXUS-MD Pairing Server running on http://0.0.0.0:${PORT}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} in use, exiting.`);
    process.exit(1);
  }
});
