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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Browser configs to try across attempts
const BROWSERS = [
  ['Ubuntu',  'Chrome',  '22.04'],
  ['Windows', 'Chrome',  '10.0' ],
  ['Ubuntu',  'Firefox', '22.04'],
  ['Mac OS',  'Chrome',  '14.4.1'],
];

async function attemptPairing(phone, browserConfig, wsUrl, send, signal) {
  const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestWaWebVersion
  } = await import('@whiskeysockets/baileys');
  const pino = (await import('pino')).default;

  if (signal?.aborted) throw new Error('Request cancelled');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-'));
  let sock = null;
  let latestCreds = null;
  let resolved = false;

  function safeFin(resolve, value) {
    if (!resolved) {
      resolved = true;
      resolve(value);
    }
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(tmpDir);

    let version;
    try {
      const v = await Promise.race([
        fetchLatestWaWebVersion(),
        sleep(8000).then(() => { throw new Error('timeout'); })
      ]);
      version = v.version;
    } catch {
      version = [2, 3000, 1015901307];
    }

    const logger = pino({ level: 'silent' });

    const sockOpts = {
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      browser: browserConfig,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 15000,
      retryRequestDelayMs: 2000,
      fireInitQueries: false,
      getMessage: async () => ({ conversation: '' })
    };

    if (wsUrl) sockOpts.waWebSocketUrl = wsUrl;

    sock = makeWASocket(sockOpts);

    // Track latest creds whenever they update
    sock.ev.on('creds.update', async (update) => {
      try {
        await saveCreds();
        latestCreds = JSON.parse(JSON.stringify(state.creds));
      } catch {}
    });

    // Wait for socket to start connecting before requesting code
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Socket failed to connect in time')), 20000);
      sock.ev.on('connection.update', function onFirst({ connection }) {
        if (connection === 'connecting' || connection === 'open') {
          clearTimeout(t);
          sock.ev.off('connection.update', onFirst);
          resolve();
        } else if (connection === 'close') {
          clearTimeout(t);
          sock.ev.off('connection.update', onFirst);
          reject(new Error('Socket closed before connecting'));
        }
      });
    });

    await sleep(600);

    if (signal?.aborted) throw new Error('Request cancelled');

    let pairingCode;
    try {
      pairingCode = await sock.requestPairingCode(phone);
    } catch (err) {
      throw new Error('Could not request pairing code: ' + (err.message || 'unknown'));
    }

    if (!pairingCode) throw new Error('WhatsApp returned an empty pairing code');
    send('code', { pairingCode });

    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        safeFin(resolve, { status: 'timeout' });
      }, 95000);

      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          safeFin(resolve, { status: 'cancelled' });
        });
      }

      sock.ev.on('connection.update', async ({ connection, isNewLogin, lastDisconnect }) => {

        // ── SUCCESS PATH: isNewLogin fires immediately when pairing is confirmed ──
        // Baileys source line ~722: "pairing configured successfully, expect to restart"
        // At this point creds already contain the session - capture them NOW
        if (isNewLogin) {
          clearTimeout(timeout);
          await sleep(800); // Allow creds.update to flush
          try {
            await saveCreds();
            const credsToUse = latestCreds || state.creds;
            if (!credsToUse || !credsToUse.me) {
              safeFin(resolve, { status: 'error', message: 'Session creds incomplete. Try again.' });
              return;
            }
            const sessionString = 'NEXUS-MD:~' + Buffer.from(JSON.stringify(credsToUse)).toString('base64');
            safeFin(resolve, { status: 'ok', sessionString });
          } catch (e) {
            safeFin(resolve, { status: 'error', message: 'Linked but session export failed. Try again.' });
          }
          return;
        }

        // ── CONNECTED OPEN (fallback success path) ──
        if (connection === 'open') {
          if (resolved) return;
          clearTimeout(timeout);
          await sleep(1200);
          try {
            const credsToUse = latestCreds || state.creds;
            const sessionString = 'NEXUS-MD:~' + Buffer.from(JSON.stringify(credsToUse)).toString('base64');
            safeFin(resolve, { status: 'ok', sessionString });
          } catch {
            safeFin(resolve, { status: 'error', message: 'Linked but session export failed. Try again.' });
          }
          return;
        }

        // ── DISCONNECTION HANDLING ──
        if (connection === 'close') {
          if (resolved) return;

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const msg = lastDisconnect?.error?.message || '';

          // 515 = restartRequired — WhatsApp ALWAYS sends this after successful pairing.
          // The socket closes here but we already have creds from isNewLogin above.
          // If isNewLogin didn't fire yet, wait — don't fail.
          if (statusCode === 515) {
            // Socket restarts — if we haven't resolved yet, the reconnect will fire connection:open
            return;
          }

          // 428 = connectionClosed — can happen transiently, ignore if code was already sent
          if (statusCode === 428) return;

          // 408 = timedOut — don't immediately fail, WhatsApp may reconnect
          if (statusCode === 408) return;

          // Hard failures: forbidden (403), loggedOut (401), badSession (500)
          clearTimeout(timeout);
          safeFin(resolve, {
            status: 'rejected',
            code: statusCode,
            reason: msg
          });
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
    }, 5000);
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

  // WS URLs: null = default Baileys choice, then explicit alternates
  const WS_URLS = [null, 'wss://web.whatsapp.com/ws/chat', 'wss://g.whatsapp.net/ws/chat', 'wss://w1.web.whatsapp.com/ws/chat'];

  try {
    let lastErr = 'Connection failed';

    for (let i = 0; i < BROWSERS.length; i++) {
      if (abortController.aborted) break;

      const browserCfg = BROWSERS[i];
      const wsUrl = WS_URLS[i] || null;
      const label = `${browserCfg[0]}/${browserCfg[1]}`;

      if (i === 0) {
        send('status', { message: 'Connecting to WhatsApp...' });
      } else {
        send('status', { message: `Retrying with alternate config (${i + 1}/${BROWSERS.length})...` });
        await sleep(2500);
      }

      if (abortController.aborted) break;

      let result;
      try {
        result = await attemptPairing(phone, browserCfg, wsUrl, send, abortController);
      } catch (err) {
        lastErr = err.message || 'Connection error';
        send('status', { message: `Config ${i + 1} failed — trying next...` });
        continue;
      }

      if (result.status === 'ok') {
        send('session', { sessionString: result.sessionString });
        return;
      }

      if (result.status === 'cancelled') break;

      if (result.status === 'timeout') {
        send('error', { message: 'Timed out. Make sure you enter the code in WhatsApp within 90 seconds.' });
        return;
      }

      if (result.status === 'error') {
        send('error', { message: result.message });
        return;
      }

      const { code, reason } = result;

      if (code === DisconnectReason.forbidden) {
        send('error', { message: 'WhatsApp blocked this pairing attempt. Use a different number or wait 10–15 minutes.' });
        return;
      }

      if (code === DisconnectReason.loggedOut) {
        if (i < BROWSERS.length - 1) { lastErr = 'Session rejected — retrying...'; continue; }
        send('error', { message: 'WhatsApp rejected this number. Wait 5–10 minutes and try again.' });
        return;
      }

      if (code === DisconnectReason.badSession) {
        if (i < BROWSERS.length - 1) { lastErr = 'Bad session — retrying with fresh config...'; continue; }
        send('error', { message: 'WhatsApp returned a bad session. Try again.' });
        return;
      }

      // Any other code — retry if possible
      if (i < BROWSERS.length - 1) {
        lastErr = reason || `Disconnected (${code}) — retrying...`;
        continue;
      }

      send('error', { message: reason || 'WhatsApp disconnected. Please try again.' });
      return;
    }

    if (!closed && !abortController.aborted) {
      send('error', { message: lastErr || 'All attempts failed. Please try again.' });
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
