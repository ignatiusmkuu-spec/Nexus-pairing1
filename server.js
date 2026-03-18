const express = require('express');
const path = require('path');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

function cleanupSession(id) {
  const data = sessions.get(id);
  if (data) {
    if (data.sock) {
      try { data.sock.end(); } catch {}
    }
    if (data.tmpDir) {
      try { fs.rmSync(data.tmpDir, { recursive: true, force: true }); } catch {}
    }
    sessions.delete(id);
  }
}

app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;

  if (!phone || !/^\d{7,15}$/.test(phone.replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'Invalid phone number. Include country code without +.' });
  }

  const cleanPhone = phone.replace(/\D/g, '');
  const sessionId = `sess_${cleanPhone}_${Date.now()}`;

  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-'));
    const { state, saveCreds } = await useMultiFileAuthState(tmpDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
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

    sessions.set(sessionId, { sock, tmpDir, state, saveCreds, resolved: false });

    const pairingCode = await sock.requestPairingCode(cleanPhone);

    const sessionPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Pairing timeout. Please try again.'));
        cleanupSession(sessionId);
      }, 90000);

      sock.ev.on('creds.update', async () => {
        await saveCreds();
      });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, isNewLogin } = update;

        if (connection === 'open') {
          clearTimeout(timeout);
          const sessionData = sessions.get(sessionId);
          if (sessionData && !sessionData.resolved) {
            sessionData.resolved = true;
            try {
              const credsPath = path.join(tmpDir, 'creds.json');
              const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
              const sessionString = 'NEXUS-MD:~' + Buffer.from(JSON.stringify(creds)).toString('base64');
              resolve({ sessionString, pairingCode });
            } catch (err) {
              reject(err);
            }
            setTimeout(() => cleanupSession(sessionId), 5000);
          }
        }

        if (connection === 'close') {
          clearTimeout(timeout);
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code !== DisconnectReason.loggedOut) {
            reject(new Error('Connection closed unexpectedly.'));
          }
          cleanupSession(sessionId);
        }
      });
    });

    res.json({ pairingCode, sessionId });

    sessionPromise.then((result) => {
      const sessionData = sessions.get(sessionId);
      if (sessionData) {
        sessionData.result = result;
      }
    }).catch(() => {});

  } catch (err) {
    cleanupSession(sessionId);
    return res.status(500).json({ error: err.message || 'Failed to generate pairing code.' });
  }
});

app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const data = sessions.get(sessionId);

  if (!data) {
    return res.json({ status: 'expired' });
  }

  if (data.result) {
    return res.json({ status: 'ready', sessionString: data.result.sessionString });
  }

  return res.json({ status: 'waiting' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`NEXUS-MD Pairing Server running on http://0.0.0.0:${PORT}`);
});

process.on('exit', () => {
  for (const [id] of sessions) {
    cleanupSession(id);
  }
});
