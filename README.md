# PremierPulse
Driver performance app

**Top-level README**

# Premier Pulse — Starter Repo (Supabase Auth + Sentry + Prometheus + Grafana)

Tracks the heartbeat of driver performance and rewards.

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
1. Create Supabase project. Note SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
2. In project root, create directories and files per repo blocks below.
3. Server:

cd server
cp .env.example .env

edit .env: set DATABASE_URL (Supabase), SUPABASE_URL, SERVICE_ROLE_KEY, SENTRY_DSN optionally

npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev

4. App:

cd app
npm install

Edit App.js SUPABASE_URL / SUPABASE_ANON_KEY and API_BASE to reachable server (e.g., http://localhost:4000
 or ngrok URL)

**npx expo start**

5. Create a Supabase Auth user via app sign-up, then call `/link-driver` route to create driver profile (the app does this automatically on first sign-in).
6. Test ingestion by calling mock partner endpoints (see README section in server folder).

## I’ll help deploy when you are ready
- When you say “deploy”, I’ll generate Docker-compose or Render/DigitalOcean/Cloud Run configs and step-by-step deployment instructions.

.gitignore

node_modules/
.env
.env.local
dist/
.expo/
*.log

**server/package.json**

{
  "name": "premier-pulse-server",
  "version": "1.0.0",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js",
    "prisma:migrate": "prisma migrate dev --name init",
    "prisma:generate": "prisma generate"
  },
  "dependencies": {
    "@prisma/client": "^5.0.0",
    "@supabase/supabase-js": "^2.28.0",
    "body-parser": "^1.20.2",
    "cors": "^2.8.5",
    "dotenv": "^16.0.3",
    "express": "^4.18.2",
    "morgan": "^1.10.0",
    "prom-client": "^14.0.1",
    "socket.io": "^4.7.2",
    "winston": "^3.8.2",
    "@sentry/node": "^7.35.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "prisma": "^5.0.0",
    "nodemon": "^3.0.1"
  }
}

**server/.env.example**

# Server environment (copy to .env)
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DBNAME?schema=public"
PORT=4000

# Supabase (from your Supabase project)
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_ANON_KEY="your-anon-key"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Sentry (optional)
SENTRY_DSN="https://examplePublicKey@o0.ingest.sentry.io/0000000"

**server/prisma/schema.prisma**

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model drivers {
  id            String   @id @default(uuid())
  phone         String   @unique
  email         String?  @unique
  name          String?
  created_at    DateTime @default(now())
  last_login    DateTime?
  vehicles      vehicles[]
  trips         trips[]
  kpi_aggregates kpi_aggregates[]
  incentives    incentives[]

  @@map("drivers")
}

model vehicles {
  id         String   @id @default(uuid())
  driver_id  String? 
  vin        String?
  plate      String?
  make       String?
  model      String?
  created_at DateTime @default(now())

  driver drivers? @relation(fields: [driver_id], references: [id])

  @@map("vehicles")
}

model raw_events {
  id              BigInt   @id @default(autoincrement())
  source          String
  source_event_id String?
  payload         Json
  received_at     DateTime @default(now())
  processed       Boolean  @default(false)

  @@map("raw_events")
}

model trips {
  id         String   @id @default(uuid())
  driver_id  String?
  vehicle_id String?
  start_time DateTime?
  end_time   DateTime?
  distance_m Float?
  score      Json?
  created_at DateTime @default(now())

  driver drivers? @relation(fields: [driver_id], references: [id])
  vehicle vehicles? @relation(fields: [vehicle_id], references: [id])

  @@map("trips")
}

model kpi_aggregates {
  id          String   @id @default(uuid())
  driver_id   String
  period_start DateTime
  period_end   DateTime
  kpis        Json
  updated_at  DateTime @default(now())

  driver drivers @relation(fields: [driver_id], references: [id])

  @@unique([driver_id, period_start, period_end], name: "driver_id_period_start_period_end")
  @@map("kpi_aggregates")
}

model incentives {
  id           String   @id @default(uuid())
  driver_id    String
  period_start DateTime
  period_end   DateTime
  amount       Decimal  @default("0.00")
  reason       String?
  metadata     Json?
  paid         Boolean  @default(false)
  created_at   DateTime @default(now())

  driver drivers @relation(fields: [driver_id], references: [id])

  @@map("incentives")
}

**server/src/index.js**

// server/src/index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { PrismaClient } = require('@prisma/client');
const morgan = require('morgan');
const winston = require('winston');
const promClient = require('prom-client');
const Sentry = require('@sentry/node');
const { v4: uuidv4 } = require('uuid');
const ingestionService = require('./services/ingestionService');
const { authMiddlewareFactory } = require('./utils/authMiddleware');

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = socketio(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Sentry init (optional)
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
  app.use(Sentry.Handlers.requestHandler());
}

// Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'premier-pulse-server' },
  transports: [ new winston.transports.Console() ]
});

// Prometheus metrics
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });
const httpRequestCounter = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method','route','status']
});
register.registerMetric(httpRequestCounter);

app.use((req,res,next) => {
  req.requestId = uuidv4();
  res.setHeader('x-request-id', req.requestId);
  next();
});
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
app.use(bodyParser.json());
app.use(cors());

// instrument request counter
app.use((req,res,next) => {
  res.on('finish', () => {
    httpRequestCounter.labels(req.method, req.path, String(res.statusCode)).inc();
  });
  next();
});

// health
app.get('/', (req,res) => res.json({ ok: true, app: 'Premier Pulse' }));

// expose prometheus metrics
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ingestion endpoint (partners)
app.post('/ingest', async (req, res) => {
  try {
    const { source, source_event_id, payload } = req.body;
    if (!source || !payload) return res.status(400).json({ error: 'missing source or payload' });
    const record = await prisma.raw_events.create({ data: { source, source_event_id: source_event_id || null, payload }});
    logger.info('ingest:received', { id: record.id, source });
    res.json({ ok: true, id: record.id });
  } catch (err) {
    logger.error('ingest-error', { error: err.message });
    res.status(500).json({ error: 'server error' });
  }
});

// link-driver: create or update drivers table using Supabase user id as id
app.post('/link-driver', authMiddlewareFactory(supabaseAdmin), async (req, res) => {
  try {
    const user = req.user; // supabase user object
    const { phone } = req.body;
    const existing = await prisma.drivers.findUnique({ where: { id: user.id }});
    if (!existing) {
      await prisma.drivers.create({
        data: { id: user.id, phone: phone || null, email: user.email, name: user.user_metadata?.full_name || null }
      });
    } else {
      await prisma.drivers.update({ where: { id: user.id }, data: { phone: phone || existing.phone }});
    }
    res.json({ ok: true, user: { id: user.id, email: user.email }});
  } catch (err) {
    logger.error('link-driver-error', { error: err.message });
    res.status(500).json({ error: 'server error' });
  }
});

// protected route to get driver + supabase user info
app.get('/me', authMiddlewareFactory(supabaseAdmin), async (req, res) => {
  try {
    const user = req.user;
    const driver = await prisma.drivers.findUnique({ where: { id: user.id }});
    res.json({ user, driver });
  } catch (err) {
    logger.error('me-error', { error: err.message });
    res.status(500).json({ error: 'server error' });
  }
});

// get scoreboard (protected)
app.get('/scoreboard', authMiddlewareFactory(supabaseAdmin), async (req, res) => {
  try {
    const driverId = req.user.id;
    const agg = await prisma.kpi_aggregates.findMany({
      where: { driver_id: driverId },
      orderBy: { updated_at: 'desc' },
      take: 1
    });
    res.json({ aggregate: agg[0] || null });
  } catch (err) {
    logger.error('scoreboard-error', { error: err.message });
    res.status(500).json({ error: 'server error' });
  }
});

// Socket.IO connection + supabase token validate
io.on('connection', (socket) => {
  logger.info('socket-connected', { id: socket.id });
  socket.on('authenticate', async ({ accessToken }) => {
    try {
      const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
      if (error || !data?.user) {
        socket.emit('authenticated', { ok: false, error: error?.message || 'invalid token' });
        return;
      }
      const user = data.user;
      socket.join(`driver:${user.id}`);
      socket.user = user;
      socket.emit('authenticated', { ok: true });
      logger.info('socket-authenticated', { socketId: socket.id, userId: user.id });
    } catch (err) {
      logger.error('socket-auth-error', { error: err.message });
      socket.emit('authenticated', { ok: false, error: 'server error' });
    }
  });
});

// helper broadcast
const broadcastScoreUpdate = (driverId, payload) => {
  io.to(`driver:${driverId}`).emit('score:update', payload);
  logger.info('broadcastScoreUpdate', { driverId });
};

// Start server + periodic worker
server.listen(PORT, () => logger.info(`Premier Pulse API running on port ${PORT}`));

async function processRawEvents() {
  try {
    const unprocessed = await prisma.raw_events.findMany({ where: { processed: false }, take: 200, orderBy: { received_at: 'asc' }});
    for (const ev of unprocessed) {
      try {
        const res = await ingestionService.processEvent(prisma, ev);
        if (res && res.driverId && res.kpis) broadcastScoreUpdate(res.driverId, { kpis: res.kpis });
        await prisma.raw_events.update({ where: { id: ev.id }, data: { processed: true }});
      } catch (err) {
        logger.error('process-event-error', { id: ev.id, error: err.message });
      }
    }
  } catch (err) {
    logger.error('processRawEvents-top', { error: err.message });
  }
}

setInterval(() => { processRawEvents().catch(e => logger.error(e)); }, 10000);

// Sentry error handler (optional)
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

**server/src/utils/authMiddleware.js**

// server/src/utils/authMiddleware.js
module.exports = {
  authMiddlewareFactory: (supabaseAdmin) => {
    return async (req, res, next) => {
      try {
        const auth = req.headers.authorization;
        if (!auth) return res.status(401).json({ error: 'no token' });
        const token = auth.split(' ')[1];
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !data?.user) return res.status(401).json({ error: 'invalid token' });
        req.user = data.user;
        next();
      } catch (err) {
        console.error('authMiddleware error', err);
        return res.status(401).json({ error: 'invalid token' });
      }
    };
  }
};

**server/src/services/ingestionService.js**

// server/src/services/ingestionService.js
// Simple normalization + aggregation for demo. Extend per partner payloads.

module.exports = {
  async processEvent(prisma, rawEvent) {
    const payload = rawEvent.payload || {};
    // Identify driver: prefer supabase user id mapping, otherwise phone
    let driver = null;
    if (payload.driver_id) {
      driver = await prisma.drivers.findUnique({ where: { id: payload.driver_id }});
    } else {
      const phone = payload.driver_phone || payload.phone || (payload.driver && payload.driver.phone);
      if (phone) driver = await prisma.drivers.findUnique({ where: { phone }});
    }

    // handle trip payload
    if (payload.trip) {
      const tripData = payload.trip;
      const trip = await prisma.trips.create({
        data: {
          driver_id: driver ? driver.id : null,
          start_time: tripData.start_time ? new Date(tripData.start_time) : null,
          end_time: tripData.end_time ? new Date(tripData.end_time) : null,
          distance_m: tripData.distance_m || 0,
          score: tripData.score || {}
        }
      });

      if (driver) {
        // weekly aggregation (Sunday- Saturday)
        const now = new Date();
        const weekStart = new Date(now);
        weekStart.setUTCDate(now.getUTCDate() - now.getUTCDay());
        weekStart.setUTCHours(0,0,0,0);
        const weekEnd = new Date(weekStart);
        weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
        weekEnd.setUTCHours(23,59,59,999);

        const existing = await prisma.kpi_aggregates.findFirst({
          where: { driver_id: driver.id, period_start: weekStart, period_end: weekEnd }
        });

        const newScore = trip.score && trip.score.total ? trip.score.total : 0;
        let combinedKpis = { score: newScore };
        if (existing) {
          const prevScore = existing.kpis?.score || 0;
          combinedKpis.score = Math.round((prevScore + newScore) / 2);
          await prisma.kpi_aggregates.update({ where: { id: existing.id }, data: { kpis: combinedKpis, updated_at: new Date() }});
        } else {
          await prisma.kpi_aggregates.create({
            data: { driver_id: driver.id, period_start: weekStart, period_end: weekEnd, kpis: combinedKpis }
          });
        }
        return { driverId: driver.id, kpis: combinedKpis };
      }
      return null;
    }

    // else no trip -> ignore for now
    return null;
  }
};

**Mock partner endpoints (server-side helper) — add to server/src/mockPartners.js**

// server/src/mockPartners.js
// Very small helper to simulate partner pushes (for local testing)
const fetch = require('node-fetch');

async function pushMock(serverBase, source, driver_phone, score) {
  const payload = {
    driver_phone,
    trip: {
      start_time: new Date().toISOString(),
      end_time: new Date(Date.now() + 1000 * 60 * 20).toISOString(),
      distance_m: 12000,
      score: { total: score, harsh_brakes: 0, speeding_minutes: 2 }
    }
  };
  const res = await fetch(`${serverBase}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, payload })
  });
  return res.json();
}

module.exports = { pushMock };

**Grafana dashboard sample - grafana/premier-pulse-dashboard.json**

{
  "annotations": { "list": [] },
  "description": "Premier Pulse - Basic metrics",
  "panels": [
    {
      "type": "graph",
      "title": "HTTP Requests",
      "targets": [{ "expr": "sum(rate(http_requests_total[1m])) by (route)" }],
      "id": 1
    },
    {
      "type": "stat",
      "title": "Unprocessed Raw Events",
      "targets": [{ "expr": "count(raw_events_processed==0) or 0" }],
      "id": 2
    }
  ],
  "title": "Premier Pulse Overview",
  "schemaVersion": 16,
  "version": 1
}

Note: Grafana target expressions above are placeholders. Once you run Prometheus scraping your server /metrics, replace expressions with the actual metric names and labels.

**Expo app files app/package.json**

{
  "name": "premier-pulse-app",
  "version": "1.0.0",
  "main": "node_modules/expo/AppEntry.js",
  "scripts": {
    "start": "expo start",
    "android": "expo run:android",
    "ios": "expo run:ios",
    "web": "expo start --web"
  },
  "dependencies": {
    "expo": "~48.0.0",
    "react": "18.2.0",
    "react-native": "0.71.8",
    "socket.io-client": "^4.7.2",
    "@react-native-async-storage/async-storage": "^1.17.11",
    "@supabase/supabase-js": "^2.28.0",
    "react-native-url-polyfill": "^1.3.0",
    "@sentry/react-native": "^4.0.0"
  },
  "devDependencies": {
    "@babel/core": "^7.20.0"
  }
}

**app/App.js**

// app/App.js — Expo + Supabase Auth + Socket.IO + Sentry RN
import 'react-native-url-polyfill/auto'; // IMPORTANT for supabase on RN
import * as Sentry from '@sentry/react-native';
import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaView, View, Text, TextInput, Button, StyleSheet, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import io from 'socket.io-client';

// CONFIG: replace with your Supabase values
const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key';
const API_BASE = 'http://localhost:4000'; // or ngrok / deployed server

// Sentry (optional)
Sentry.init({ dsn: 'YOUR_SENTRY_DSN', enableAutoSessionTracking: true });

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function App() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [session, setSession] = useState(null);
  const [driver, setDriver] = useState(null);
  const [score, setScore] = useState(null);
  const socketRef = useRef(null);

  useEffect(() => {
    (async () => {
      const s = await AsyncStorage.getItem('supabase_session');
      if (s) {
        const parsed = JSON.parse(s);
        setSession(parsed);
        await fetchMe(parsed.access_token);
        connectSocket(parsed.access_token);
      }
    })();
    return () => { if (socketRef.current) socketRef.current.disconnect(); };
  }, []);

  const fetchMe = async (accessToken) => {
    try {
      const r = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${accessToken}` }});
      const j = await r.json();
      if (j.driver) setDriver(j.driver);
    } catch (e) {
      Sentry.captureException(e);
      console.log(e);
    }
  };

  const connectSocket = (accessToken) => {
    socketRef.current = io(API_BASE, { transports: ['websocket'] });
    socketRef.current.on('connect', () => socketRef.current.emit('authenticate', { accessToken }));
    socketRef.current.on('authenticated', (d) => console.log('socket auth', d));
    socketRef.current.on('score:update', (payload) => setScore(payload.kpis || payload));
  };

  const handleSignup = async () => {
    try {
      const email = `${phone}@mobile.local`;
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        alert('Signup error: ' + error.message);
        return;
      }
      alert('Signup success. Check email for confirmation (or use signIn).');
    } catch (e) {
      Sentry.captureException(e);
      console.log(e);
    }
  };

  const handleSignin = async () => {
    try {
      const email = `${phone}@mobile.local`;
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { alert('Signin error: ' + error.message); return; }
      await AsyncStorage.setItem('supabase_session', JSON.stringify(data.session));
      setSession(data.session);
      // Link driver row server-side
      await fetch(`${API_BASE}/link-driver`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ phone })
      });
      await fetchMe(data.session.access_token);
      connectSocket(data.session.access_token);
    } catch (e) {
      Sentry.captureException(e);
      console.log(e);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    await AsyncStorage.removeItem('supabase_session');
    setSession(null);
    setDriver(null);
    if (socketRef.current) socketRef.current.disconnect();
  };

  const renderAuth = () => (
    <SafeAreaView style={styles.container}>
      <Text style={{fontSize:20}}>Premier Pulse — Driver</Text>
      <TextInput placeholder="phone" style={styles.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <TextInput placeholder="password" style={styles.input} secureTextEntry value={password} onChangeText={setPassword} />
      <View style={{flexDirection:'row', gap:10}}>
        <Button title="Signup" onPress={handleSignup} />
        <Button title="Signin" onPress={handleSignin} />
      </View>
    </SafeAreaView>
  );

  const renderScoreboard = () => (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={{alignItems:'center', width:'100%'}}>
        <Text style={{fontSize:18}}>Welcome, {driver ? driver.name : session?.user?.email}</Text>
        <Text style={{marginTop:10, fontSize:16}}>Live Score:</Text>
        <Text style={{fontSize:28, fontWeight:'700', marginVertical:12}}>{score ? JSON.stringify(score) : 'Waiting for data...'}</Text>
        <Button title="Fetch latest scoreboard" onPress={async () => {
          const r = await fetch(`${API_BASE}/scoreboard`, { headers: { Authorization: `Bearer ${session.access_token}` }});
          const j = await r.json();
          setScore(j.aggregate ? j.aggregate.kpis : null);
        }} />
        <View style={{marginTop:12}}><Button title="Sign out" onPress={handleSignOut} /></View>
      </ScrollView>
    </SafeAreaView>
  );

  return session ? renderScoreboard() : renderAuth();
}

const styles = StyleSheet.create({
  container: { flex:1, alignItems:'center', justifyContent:'center', padding:20 },
  input: { borderWidth:1, width:'100%', padding:10, marginVertical:8, borderRadius:6 }
});

Quick local testing (mock partners)

After server & app running:

Create driver via app sign-up & sign-in. This will call /link-driver and create a drivers row with Supabase user id.

Simulate partner sending a trip (curl example):

curl -X POST http://localhost:4000/ingest \
  -H "content-type: application/json" \
  -d '{
    "source":"platform_services",
    "source_event_id":"evt_123",
    "payload":{
      "driver_phone":"+15551234567",
      "trip": {
        "start_time":"2025-10-05T10:00:00Z",
        "end_time":"2025-10-05T10:30:00Z",
        "distance_m": 12000,
        "score": { "total": 96, "harsh_brakes": 0, "speeding_minutes": 2 }
      }
    }
  }'

If the driver exists (phone or supabase id), the worker will process and broadcast a score:update to the driver's connected socket in the app.

