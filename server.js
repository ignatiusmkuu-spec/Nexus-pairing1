const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const WS_URLS = [
  'wss://web.whatsapp.com/ws/chat',
  'wss://g.whatsapp.net/ws/chat',
  'wss://w1.web.whatsapp.com/ws/chat',
  'wss://w2.web.whatsapp.com/ws/chat'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attemptPairing(phone, wsUrl, send, signal) {
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
  let latestCreds = null;

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

    if (signal?.aborted) throw new Error('Request cancelled');

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
      connectTimeoutMs: 25000,
      keepAliveIntervalMs: 8000,
      retryRequestDelayMs: 2000,
      fireInitQueries: false
    });

    sock.ev.on('creds.update', async (update) => {
      try {
        await saveCreds();
        latestCreds = JSON.parse(JSON.stringify(state.creds));
      } catch {}
    });

    let pairingCode;
    try {
      pairingCode = await sock.requestPairingCode(phone);
    } catch (err) {
      throw new Error('Failed to request pairing code: ' + (err.message || 'unknown error'));
    }

    send('code', { pairingCode });

    let succeeded = false;

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!succeeded) {
          resolve({ status: 'timeout' });
        }
      }, 90000);

      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          resolve({ status: 'cancelled' });
        });
      }

      sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
          succeeded = true;
          clearTimeout(timeout);
          await sleep(1200);
          try {
            const credsToUse = latestCreds || state.creds;
            const sessionString = 'NEXUS-MD:~' + Buffer.from(JSON.stringify(credsToUse)).toString('base64');
            resolve({ status: 'ok', sessionString });
          } catch (e) {
            resolve({ status: 'error', message: 'Linked but could not export session. Try again.' });
          }
        }

        if (connection === 'close') {
          if (succeeded) return;
          clearTimeout(timeout);
          const code = lastDisconnect?.error?.output?.statusCode;
          resolve({ status: 'rejected', code });
        }
      });
    });

  } finally {
    if (sock) {
      try { sock.end(); } catch {}
      try { sock.ev.removeAllListeners(); } catch {}
    }
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }, 3000);
  }
}

app.get('/api/pair', async (req, res) => {
  const phone = (req.query.phone || '').replace(/\D/g, '');

  if (!phone || phone.length < 7 || phone.length > 15) {
    return res.status(400).json({ error: 'Invalid phone number. Include country code without +.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let closed = false;
  const abortController = { aborted: false };

  req.on('close', () => {
    closed = true;
    abortController.aborted = true;
  });

  function send(event, data) {
    if (closed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch {}
  }

  const pingInterval = setInterval(() => {
    if (closed) { clearInterval(pingInterval); return; }
    try { res.write(': ping\n\n'); if (typeof res.flush === 'function') res.flush(); } catch {}
  }, 10000);

  const { DisconnectReason } = await import('@whiskeysockets/baileys');

  try {
    let lastErr = null;
    for (let i = 0; i < WS_URLS.length; i++) {
      if (abortController.aborted) break;

      if (i > 0) {
        send('status', { message: `Retrying via alternate server ${i + 1}/${WS_URLS.length}...` });
        await sleep(3000);
      } else {
        send('status', { message: 'Connecting to WhatsApp servers...' });
      }

      if (abortController.aborted) break;

      let result;
      try {
        result = await attemptPairing(phone, WS_URLS[i], send, abortController);
      } catch (err) {
        lastErr = err.message || 'Unknown error';
        send('status', { message: `Server ${i + 1} failed, trying next...` });
        continue;
      }

      if (result.status === 'ok') {
        send('session', { sessionString: result.sessionString });
        return;
      }

      if (result.status === 'cancelled') break;

      if (result.status === 'timeout') {
        send('error', { message: 'Pairing timed out. Make sure you entered the code in WhatsApp within 90 seconds.' });
        return;
      }

      if (result.status === 'error') {
        send('error', { message: result.message });
        return;
      }

      const { code } = result;

      if (code === DisconnectReason.forbidden) {
        send('error', { message: 'Pairing blocked by WhatsApp. Try a different number or wait 10–15 minutes.' });
        return;
      }

      if (code === DisconnectReason.loggedOut && i < WS_URLS.length - 1) {
        lastErr = 'Session rejected, trying alternate server...';
        continue;
      }

      send('error', {
        message: code === DisconnectReason.loggedOut
          ? 'WhatsApp rejected the session. Wait 5–10 minutes then try again.'
          : 'WhatsApp disconnected unexpectedly. Please try again.'
      });
      return;
    }

    if (!closed) {
      send('error', { message: lastErr || 'All servers failed. Please try again in a few minutes.' });
    }

  } catch (err) {
    send('error', { message: err.message || 'An unexpected error occurred.' });
  } finally {
    clearInterval(pingInterval);
    if (!closed) {
      try { res.end(); } catch {}
    }
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
