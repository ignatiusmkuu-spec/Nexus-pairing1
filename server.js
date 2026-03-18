const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/pair', async (req, res) => {
  const phone = (req.query.phone || '').replace(/\D/g, '');

  if (!phone || phone.length < 7) {
    return res.status(400).json({ error: 'Invalid phone number. Include country code without +.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  }

  const pingInterval = setInterval(() => {
    res.write(': ping\n\n');
    if (typeof res.flush === 'function') res.flush();
  }, 20000);

  let tmpDir = null;
  let sock = null;

  function cleanup() {
    clearInterval(pingInterval);
    if (sock) { try { sock.end(); } catch {} sock = null; }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} tmpDir = null; }
  }

  req.on('close', cleanup);

  try {
    const {
      makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      makeCacheableSignalKeyStore,
      fetchLatestBaileysVersion
    } = await import('@whiskeysockets/baileys');

    const pino = (await import('pino')).default;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-'));
    const { state, saveCreds } = await useMultiFileAuthState(tmpDir);

    let version;
    try {
      const v = await fetchLatestBaileysVersion();
      version = v.version;
    } catch {
      version = [2, 3000, 1015901307];
    }

    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      browser: ['NEXUS-MD', 'Chrome', '3.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      connectTimeoutMs: 30000
    });

    const pairingCode = await sock.requestPairingCode(phone);
    send('code', { pairingCode });

    sock.ev.on('creds.update', saveCreds);

    await new Promise((resolve) => {
      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          try {
            const credsPath = path.join(tmpDir, 'creds.json');
            const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            const sessionString = 'NEXUS-MD:~' + Buffer.from(JSON.stringify(creds)).toString('base64');
            send('session', { sessionString });
          } catch {
            send('error', { message: 'Linked but failed to read session. Try again.' });
          }
          resolve();
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code !== DisconnectReason.loggedOut) {
            send('error', { message: 'WhatsApp connection closed. Please try again.' });
          }
          resolve();
        }
      });
    });

    cleanup();
    res.end();

  } catch (err) {
    console.error('pair error:', err.message);
    send('error', { message: err.message || 'Server error. Please try again.' });
    cleanup();
    res.end();
  }
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
