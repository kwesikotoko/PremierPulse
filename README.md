# Premier Pulse — Starter Repo (Supabase Auth + Sentry + Prometheus + Grafana)

Tracks the heartbeat of driver performance and rewards for Premier Transportation.

This repo contains:
- server/ : Node.js + Express + Socket.IO + Prisma backend (Supabase Auth validated server-side)
- app/    : Expo React Native driver app (Supabase Auth + Socket.IO + Sentry)
- grafana/ : sample Grafana dashboard JSON
- instructions for running locally and testing with mock partners

## Quick overview
- Local-first development. Use Supabase for Postgres + Auth.
- Sentry: capture runtime errors (set SENTRY_DSN).
- Prometheus: metrics exposed at `/metrics` for scraping.
- Grafana: import provided dashboard JSON to visualize metrics.

## Prereqs (local)
- Node 18+
- npm or yarn
- Expo CLI (`npm i -g expo-cli`) or use `npx expo`
- A Supabase project (for Auth + Postgres). Copy `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- SENTRY_DSN (optional for error tracking)

## Local run (short)
1. Create Supabase project. Note `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
2. In project root, create directories and files per repo blocks below.
3. Server:

```bash
cd server
cp .env.example .env

# edit .env: set DATABASE_URL (Supabase), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SENTRY_DSN optionally

npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

4. App:

```bash
cd app
npm install

# Edit App.js SUPABASE_URL / SUPABASE_ANON_KEY and API_BASE to reachable server (e.g., http://localhost:4000 or ngrok URL)

npm start
```

## Prometheus & Grafana
- Prometheus scrapes `http://localhost:4000/metrics` by default.
- Import `grafana/premier-pulse-dashboard.json` into Grafana to visualize request rates, latencies, and custom app metrics.

## Notes
- Supabase Auth is verified server-side using the Service Role key to fetch the user for Bearer tokens.
- Socket.IO authenticates with the same token via `auth: { token }`.
- Prisma models include `Driver` and `Trip` (basic starter for performance analytics).
