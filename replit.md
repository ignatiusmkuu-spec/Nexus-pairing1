# NEXUS-MD Pairing Session

## Project Overview
A WhatsApp pairing session generator with a hacker/terminal aesthetic. Users enter their phone number, get an 8-character pairing code (displayed as `NEXUS-BOT` style), link their device in WhatsApp, and receive their session string in `NEXUS-MD:~<base64>` format.

## Tech Stack
- **Runtime:** Node.js 20
- **Framework:** Express 4.x
- **WhatsApp:** @whiskeysockets/baileys
- **Frontend:** Vanilla HTML/CSS/JS with matrix rain canvas

## Project Structure
```
├── server.js           # Express server + Baileys pairing API
├── package.json        # Dependencies
├── vercel.json         # Vercel deployment config
├── public/
│   └── index.html      # Frontend UI (hacker terminal theme)
└── .gitignore
```

## API Endpoints
- `POST /api/pair` — body: `{ phone: "254..." }` → returns `{ pairingCode, sessionId }`
- `GET /api/session/:sessionId` → returns `{ status: "waiting"|"ready"|"expired", sessionString? }`

## Session Format
`NEXUS-MD:~` + base64(JSON.stringify(baileys_creds))

## Running
The app runs on port 5000 via the "Start application" workflow.

## Deployment
Configured for autoscale on Replit and Vercel (vercel.json included).
Run: `node server.js`
