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
  res.status(201).json({ trip });
});

// Error handler
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

// Socket.IO
const io = new Server(server, {
  cors: { origin: corsOrigins, credentials: true }
});

ios.use(socketAuth);

io.on('connection', (socket) => {
  // Example: emit live score updates in future
  socket.emit('hello', { message: 'Connected to Premier Pulse' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
