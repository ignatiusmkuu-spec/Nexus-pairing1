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

// Each attempt config: optionally override wsUrl and browser
const ATTEMPT_CONFIGS = [
  { label: 'default server',    wsUrl: null,                              browser: ['Ubuntu',  'Chrome',  '22.04'] },
  { label: 'alternate server A', wsUrl: 'wss://web.whatsapp.com/ws/chat', browser: ['Windows', 'Chrome',  '10']    },
  { label: 'alternate server B', wsUrl: 'wss://g.whatsapp.net/ws/chat',   browser: ['Ubuntu',  'Firefox', '22.04'] },
  { label: 'alternate server C', wsUrl: 'wss://w1.web.whatsapp.com/ws/chat', browser: ['MacOS', 'Safari', '16']   },
];

async function attemptPairing(phone, config, send, signal) {
  const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
  } = await import('@whiskeysockets/baileys');
  const pino = (await import('pino')).default;

  if (signal?.aborted) throw new Error('Request cancelled');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-'));
  let sock = null;
  let latestCreds = null;
  let pairCodeSent = false;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(tmpDir);

    let version;
    try {
      const result = await Promise.race([
        fetchLatestBaileysVersion(),
        sleep(8000).then(() => { throw new Error('version fetch timeout'); })
      ]);
      version = result.version;
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
      browser: config.browser,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 10000,
      retryRequestDelayMs: 3000,
      fireInitQueries: false,
      getMessage: async () => ({ conversation: '' })
    };

    if (config.wsUrl) {
      sockOpts.waWebSocketUrl = config.wsUrl;
    }

    sock = makeWASocket(sockOpts);

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        latestCreds = JSON.parse(JSON.stringify(state.creds));
      } catch {}
    });

    // Wait for connecting state before requesting pairing code
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Socket did not connect in time')), 15000);
      const check = ({ connection }) => {
        if (connection === 'connecting' || connection === 'open') {
          clearTimeout(t);
          sock.ev.off('connection.update', check);
          resolve();
        }
        if (connection === 'close') {
          clearTimeout(t);
          sock.ev.off('connection.update', check);
          reject(new Error('Socket closed before connecting'));
        }
      };
      sock.ev.on('connection.update', check);
    });

    if (signal?.aborted) throw new Error('Request cancelled');

    // Small delay to let the socket stabilise
    await sleep(800);

    let pairingCode;
    try {
      pairingCode = await sock.requestPairingCode(phone);
    } catch (err) {
      throw new Error('Could not request pairing code: ' + (err.message || 'unknown'));
    }

    if (!pairingCode) throw new Error('Empty pairing code returned by WhatsApp');

    pairCodeSent = true;
    send('code', { pairingCode });

    let succeeded = false;

    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!succeeded) resolve({ status: 'timeout' });
      }, 95000);

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
          await sleep(1500);
          try {
            const credsToUse = latestCreds || state.creds;
            const sessionString = 'NEXUS-MD:~' + Buffer.from(JSON.stringify(credsToUse)).toString('base64');
            resolve({ status: 'ok', sessionString });
          } catch {
            resolve({ status: 'error', message: 'Device linked but session export failed. Try again.' });
          }
          return;
        }

        if (connection === 'close') {
          if (succeeded) return;
          clearTimeout(timeout);
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason = lastDisconnect?.error?.message || '';

          // If the code was already sent and WA closes, it could be a recoverable disconnect
          if (pairCodeSent && statusCode === undefined) {
            // Network blip after code sent — keep waiting if within timeout
            return;
          }

          resolve({ status: 'rejected', code: statusCode, reason });
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
    }, 4000);
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
    let lastErr = 'Unknown error';

    for (let i = 0; i < ATTEMPT_CONFIGS.length; i++) {
      if (abortController.aborted) break;

      const cfg = ATTEMPT_CONFIGS[i];

      if (i === 0) {
        send('status', { message: 'Connecting to WhatsApp...' });
      } else {
        send('status', { message: `Trying ${cfg.label} (${i + 1}/${ATTEMPT_CONFIGS.length})...` });
        await sleep(2500);
      }

      if (abortController.aborted) break;

      let result;
      try {
        result = await attemptPairing(phone, cfg, send, abortController);
      } catch (err) {
        lastErr = err.message || 'Connection error';
        send('status', { message: `${cfg.label} failed — trying next...` });
        continue;
      }

      if (result.status === 'ok') {
        send('session', { sessionString: result.sessionString });
        return;
      }

      if (result.status === 'cancelled') break;

      if (result.status === 'timeout') {
        send('error', { message: 'Timed out waiting for device link. Enter the code in WhatsApp within 90 seconds.' });
        return;
      }

      if (result.status === 'error') {
        send('error', { message: result.message });
        return;
      }

      const { code, reason } = result;

      if (code === DisconnectReason.forbidden) {
        send('error', { message: 'WhatsApp blocked this pairing attempt. Try a different number or wait 10–15 minutes.' });
        return;
      }

      if (code === DisconnectReason.loggedOut) {
        if (i < ATTEMPT_CONFIGS.length - 1) {
          lastErr = 'Session rejected by WhatsApp, trying alternate...';
          continue;
        }
        send('error', { message: 'WhatsApp rejected this number. Wait 5–10 minutes then try again.' });
        return;
      }

      // For other codes, retry unless we're on the last config
      if (i < ATTEMPT_CONFIGS.length - 1) {
        lastErr = reason || `Disconnected (code ${code}), retrying...`;
        send('status', { message: `Disconnected — trying ${ATTEMPT_CONFIGS[i + 1].label}...` });
        continue;
      }

      send('error', { message: reason || 'WhatsApp disconnected. Please try again in a few minutes.' });
      return;
    }

    if (!closed && abortController.aborted === false) {
      send('error', { message: lastErr || 'All connection attempts failed. Please try again shortly.' });
    }

  } catch (err) {
    send('error', { message: err.message || 'An unexpected server error occurred.' });
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
