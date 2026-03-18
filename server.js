const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const WS_URLS = [
  'wss://web.whatsapp.com/ws/chat',
  'wss://g.whatsapp.net/ws/chat'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attemptPairing(phone, wsUrl, send) {
  const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    Browsers
  } = await import('@whiskeysockets/baileys');
  const pino = (await import('pino')).default;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-'));
  let sock = null;

  try {
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
      browser: Browsers.appropriate('Chrome'),
      waWebSocketUrl: wsUrl,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 10000
    });

    const pairingCode = await sock.requestPairingCode(phone);
    send('code', { pairingCode });

    sock.ev.on('creds.update', saveCreds);

    let succeeded = false;

    return await new Promise((resolve) => {
      sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
          succeeded = true;
          try {
            const sessionString =
              'NEXUS-MD:~' + Buffer.from(JSON.stringify(state.creds)).toString('base64');
            resolve({ status: 'ok', sessionString });
          } catch {
            resolve({ status: 'error', message: 'Linked but could not export session. Try again.' });
          }
        }

        if (connection === 'close') {
          if (succeeded) return;
          const code = lastDisconnect?.error?.output?.statusCode;
          resolve({ status: 'rejected', code });
        }
      });
    });

  } finally {
    if (sock) { try { sock.end(); } catch {} }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

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
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch {}
  }

  const pingInterval = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 15000);

  // Dynamic import DisconnectReason for the retry loop
  const { DisconnectReason } = await import('@whiskeysockets/baileys');

  try {
    for (let i = 0; i < WS_URLS.length; i++) {
      if (i > 0) {
        send('status', { message: 'Retrying via alternate server...' });
        await sleep(4000);
      }

      let result;
      try {
        result = await attemptPairing(phone, WS_URLS[i], send);
      } catch (err) {
        if (i < WS_URLS.length - 1) continue;
        send('error', { message: err.message || 'Failed to connect to WhatsApp.' });
        break;
      }

      if (result.status === 'ok') {
        send('session', { sessionString: result.sessionString });
        break;
      }

      if (result.status === 'error') {
        send('error', { message: result.message });
        break;
      }

      const { code } = result;

      if (code === DisconnectReason.forbidden) {
        send('error', { message: 'Pairing blocked by WhatsApp. Try a different number or wait 10 minutes.' });
        break;
      }

      if (code === DisconnectReason.loggedOut && i < WS_URLS.length - 1) {
        continue;
      }

      send('error', {
        message: code === DisconnectReason.loggedOut
          ? 'WhatsApp rejected the session. Wait 5-10 minutes then try again.'
          : 'WhatsApp disconnected unexpectedly. Please try again.'
      });
      break;
    }

  } finally {
    clearInterval(pingInterval);
    try { res.end(); } catch {}
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
