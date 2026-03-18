import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';

async function runPairing(phone, send) {
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
      browser: ['NEXUS-MD', 'Chrome', '3.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      connectTimeoutMs: 30000
    });

    // Request pairing code — throws if WhatsApp rejects the phone
    const pairingCode = await sock.requestPairingCode(phone);
    send('code', { pairingCode });

    sock.ev.on('creds.update', saveCreds);

    // Wait for connection to open (success) or close (failure)
    // Track whether we already succeeded so a post-open close doesn't overwrite the result
    let succeeded = false;

    await new Promise((resolve) => {
      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          succeeded = true;
          // Use the in-memory creds — they are up to date at this point.
          // Do NOT read from disk; the file write may still be in flight.
          try {
            const sessionString =
              'NEXUS-MD:~' + Buffer.from(JSON.stringify(state.creds)).toString('base64');
            send('session', { sessionString });
          } catch (e) {
            send('error', { message: 'Linked but could not export session. Try again.' });
          }
          resolve();
        }

        if (connection === 'close') {
          if (succeeded) {
            // Normal post-open disconnect — ignore, session was already sent
            resolve();
            return;
          }
          const code = lastDisconnect?.error?.output?.statusCode;
          const reason =
            code === DisconnectReason.loggedOut
              ? 'WhatsApp rejected the request. Wait a moment and try again.'
              : code === DisconnectReason.forbidden
              ? 'Pairing forbidden by WhatsApp. Try a different number or wait.'
              : 'WhatsApp disconnected. Please try again.';
          send('error', { message: reason });
          resolve();
        }
      });
    });

  } finally {
    if (sock) { try { sock.end(); } catch {} }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

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

  // Server-Sent Events — keeps the Lambda alive while user links device
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

  // Keep-alive ping every 15 s so reverse proxies don't drop the stream
  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch {}
  }, 15000);

  try {
    await runPairing(phone, send);
  } catch (err) {
    console.error('NEXUS pair error:', err.message);
    send('error', { message: err.message || 'Server error. Please try again.' });
  } finally {
    clearInterval(pingInterval);
    try { res.end(); } catch {}
  }
}
