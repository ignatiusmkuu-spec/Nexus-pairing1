import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const phone = (url.searchParams.get('phone') || '').replace(/\D/g, '');

  if (!phone || phone.length < 7) {
    res.status(400).json({ error: 'Invalid phone number. Include country code without +.' });
    return;
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
    try {
      res.write(': ping\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch {}
  }, 15000);

  let tmpDir = null;
  let sock = null;

  function cleanup() {
    clearInterval(pingInterval);
    if (sock) { try { sock.end(); } catch {} sock = null; }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} tmpDir = null; }
  }

  req.on('close', cleanup);

  try {
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
          } catch (e) {
            send('error', { message: 'Linked but failed to read session. Try again.' });
          }
          resolve();
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          send('error', {
            message: code === DisconnectReason.loggedOut
              ? 'Account logged out. Try again.'
              : 'WhatsApp disconnected. Please try again.'
          });
          resolve();
        }
      });
    });

  } catch (err) {
    console.error('NEXUS pair error:', err.message);
    send('error', { message: err.message || 'Server error. Please try again.' });
  } finally {
    cleanup();
    try { res.end(); } catch {}
  }
}
