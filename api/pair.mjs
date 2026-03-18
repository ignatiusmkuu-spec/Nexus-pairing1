import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';

const WS_URLS = [
  'wss://web.whatsapp.com/ws/chat',
  'wss://g.whatsapp.net/ws/chat'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Returns:
 *   { status: 'ok', sessionString }
 *   { status: 'rejected', code: <statusCode> }
 *   { status: 'error', message }
 *
 * Calls send('code', { pairingCode }) immediately when code is ready.
 */
async function attemptPairing(phone, wsUrl, send) {
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

    // Get and immediately broadcast the pairing code
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
          if (succeeded) return; // normal post-open close, ignore
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
    try { res.write(': ping\n\n'); if (typeof res.flush === 'function') res.flush(); } catch {}
  }, 15000);

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

      // status === 'rejected'
      const { code } = result;

      if (code === DisconnectReason.forbidden) {
        send('error', { message: 'Pairing blocked by WhatsApp. Try a different number or wait 10 minutes.' });
        break;
      }

      if (code === DisconnectReason.loggedOut && i < WS_URLS.length - 1) {
        // Try next endpoint
        continue;
      }

      // All endpoints exhausted or other disconnect
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
}
