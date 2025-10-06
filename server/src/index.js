require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const { Server } = require('socket.io');
const Sentry = require('@sentry/node');
const client = require('prom-client');

const { authMiddleware, socketAuth } = require('./supabaseAuth');
const { prisma } = require('./prisma');

const app = express();
const server = http.createServer(app);

// Sentry
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
  app.use(Sentry.Handlers.requestHandler());
}

// Prometheus metrics
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5]
});

app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.route?.path || req.path, status_code: res.statusCode });
  });
  next();
});

// Middlewares
const corsOrigins = (process.env.CORS_ORIGIN || '*').split(',');
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(helmet());
app.use(compression());
app.use(express.json());
app.use(morgan('dev'));

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Metrics
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// Helpers for summaries and leaderboards
async function computeDriverSummary(driverId, days) {
  const where = { driverId };
  if (days && Number.isFinite(Number(days))) {
    where.startTime = { gte: new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000) };
  }
  const agg = await prisma.trip.aggregate({
    where,
    _count: { _all: true },
    _sum: { distanceKm: true, fuelUsedLiters: true },
    _avg: { score: true, averageSpeedKph: true }
  });
  const lastTrip = await prisma.trip.findFirst({ where: { driverId }, orderBy: { startTime: 'desc' } });
  return {
    totalTrips: agg._count?._all || 0,
    totalDistanceKm: agg._sum?.distanceKm || 0,
    totalFuelLiters: agg._sum?.fuelUsedLiters || 0,
    averageScore: agg._avg?.score || null,
    averageSpeedKph: agg._avg?.averageSpeedKph || null,
    lastTrip
  };
}

async function getLeaderboard(days, limit = 10) {
  const where = {};
  if (days && Number.isFinite(Number(days))) {
    where.startTime = { gte: new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000) };
  }
  const grouped = await prisma.trip.groupBy({
    by: ['driverId'],
    where,
    _avg: { score: true },
    _sum: { distanceKm: true },
    _count: { _all: true },
    orderBy: { _avg: { score: 'desc' } },
    take: limit
  });
  const driverIds = grouped.map((g) => g.driverId);
  const drivers = await prisma.driver.findMany({ where: { id: { in: driverIds } } });
  const driverMap = new Map(drivers.map((d) => [d.id, d]));
  return grouped.map((g, idx) => ({
    rank: idx + 1,
    driverId: g.driverId,
    name: driverMap.get(g.driverId)?.name || 'Driver',
    averageScore: g._avg.score,
    trips: g._count._all,
    totalDistanceKm: g._sum.distanceKm || 0
  }));
}

// Authenticated routes
app.use(authMiddleware);

app.get('/me', async (req, res) => {
  return res.json({ user: req.user, driver: req.driver });
});

app.get('/trips', async (req, res) => {
  const trips = await prisma.trip.findMany({ where: { driverId: req.driver.id }, orderBy: { startTime: 'desc' } });
  res.json({ trips });
});

app.post('/trips', async (req, res) => {
  const { startTime, endTime, distanceKm, averageSpeedKph, harshBrakes, overspeeds, fuelUsedLiters, score } = req.body;
  const trip = await prisma.trip.create({ data: {
    driverId: req.driver.id,
    startTime: new Date(startTime),
    endTime: endTime ? new Date(endTime) : null,
    distanceKm,
    averageSpeedKph,
    harshBrakes: harshBrakes ?? 0,
    overspeeds: overspeeds ?? 0,
    fuelUsedLiters,
    score
  }});
  // Emit updates to this driver and global leaderboard
  try {
    const ioInstance = req.app.get('io');
    if (ioInstance) {
      const summary = await computeDriverSummary(req.driver.id, 30);
      const leaderboard = await getLeaderboard(30, 10);
      ioInstance.to(`driver:${req.driver.id}`).emit('summary:update', summary);
      ioInstance.emit('leaderboard:update', leaderboard);
    }
  } catch (e) {
    // ignore emit errors
  }
  res.status(201).json({ trip });
});

app.get('/summary', async (req, res) => {
  const days = req.query.days ? Number(req.query.days) : undefined;
  const summary = await computeDriverSummary(req.driver.id, days);
  res.json({ summary });
});

app.get('/leaderboard', async (req, res) => {
  const days = req.query.days ? Number(req.query.days) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 10;
  const leaderboard = await getLeaderboard(days, limit);
  res.json({ leaderboard });
});

// Error handler
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

// Socket.IO
const io = new Server(server, {
  cors: { origin: corsOrigins, credentials: true }
});

io.use(socketAuth);

io.on('connection', (socket) => {
  // Example: emit live score updates in future
  socket.emit('hello', { message: 'Connected to Premier Pulse' });
  // Join a per-driver room for targeted updates
  const driverId = socket.data?.driver?.id;
  if (driverId) {
    socket.join(`driver:${driverId}`);
  }
});

// Expose io to routes
app.set('io', io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
