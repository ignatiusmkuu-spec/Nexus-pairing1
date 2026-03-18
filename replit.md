# NEXUS-MD Pairing Session

## Project Overview
WhatsApp pairing session generator with a terminal hacker aesthetic. Users enter their phone number, get an 8-char pairing code (NEXUS-BOT style), link their device in WhatsApp, and receive a session string in `NEXUS-MD:~<base64>` format.

## Tech Stack
- **Runtime:** Node.js 20
- **Framework:** Express 4.x (Replit) / Vercel Serverless (Vercel)
- **WhatsApp:** @whiskeysockets/baileys 7.x
- **Frontend:** Vanilla HTML/CSS/JS — matrix rain, music player, battery HUD

## Project Structure
```
├── server.js           # Replit Express server
├── api/
│   └── pair.js         # Vercel serverless function (same logic)
├── package.json
├── vercel.json         # Vercel: bundle=false, static public/
├── public/
│   ├── index.html      # Frontend UI
│   └── nexus_drill.mp3 # Background music
```

## API
Both `server.js` (Replit) and `api/pair.js` (Vercel) expose:

- `GET /api/pair?action=start&phone=254...` → `{ id, pairingCode }`
- `GET /api/pair?action=status&id=...` → `{ status, sessionString, error }`

`status` values: `pending` | `ready` | `error` | `expired`

## Session Format
`NEXUS-MD:~` + base64(JSON.stringify(baileys_creds))

## Vercel Deployment
Push to GitHub → Import on Vercel → deploy. Zero extra config needed.
- `api/pair.js` → `/api/pair` serverless function
- `public/` → static assets served at root
- `bundle: false` in vercel.json prevents ncc from mangling Baileys

## Replit Deployment
App runs on port 5000. Deploy via Replit Autoscale.
