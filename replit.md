# Nexus Pairing

## Project Overview
A Node.js/Express web application running on Replit.

## Tech Stack
- **Runtime:** Node.js 20
- **Framework:** Express 4.x
- **Frontend:** Static HTML/CSS served from the `public/` directory

## Project Structure
```
├── server.js        # Express server entry point
├── package.json     # Node.js dependencies
├── public/
│   └── index.html   # Frontend HTML page
└── .gitignore
```

## Running the App
The app runs on port 5000 via the "Start application" workflow.

```bash
node server.js
```

## Deployment
Configured for autoscale deployment on Replit.
Run command: `node server.js`
