const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async function handler(req, res) {
  const phone = (req.query.phone || '').replace(/\D/g, '');

  if (!phone || phone.length < 7) {
    res.status(400).json({ error: 'Invalid phone number.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  }

  let tmpDir = null;
  let sock = null;

  function cleanup() {
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
    } = require('@whiskeysockets/baileys');

    const pino = require('pino');

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-'));
    const { state, saveCreds } = await useMultiFileAuthState(tmpDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      printQRInTerminal: false,
      browser: ['NEXUS-MD', 'Chrome', '3.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false
    });

    const pairingCode = await sock.requestPairingCode(phone);
    send('code', { pairingCode });

    const timeoutHandle = setTimeout(() => {
      send('error', { message: 'Pairing timed out. Please try again.' });
      cleanup();
      res.end();
    }, 90000);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        clearTimeout(timeoutHandle);
        try {
          const credsPath = path.join(tmpDir, 'creds.json');
          const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
          const sessionString = 'NEXUS-MD:~' + Buffer.from(JSON.stringify(creds)).toString('base64');
          send('session', { sessionString });
        } catch (e) {
          send('error', { message: 'Failed to generate session.' });
        }
        cleanup();
        res.end();
      }

      if (connection === 'close') {
        clearTimeout(timeoutHandle);
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          send('error', { message: 'Connection dropped. Try again.' });
        }
        cleanup();
        res.end();
      }
    });

  } catch (err) {
    console.error('Pair error:', err.message);
    send('error', { message: err.message || 'Server error. Please try again.' });
    cleanup();
    res.end();
  }
};
