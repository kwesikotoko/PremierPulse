const { createClient } = require('@supabase/supabase-js');
const { prisma } = require('./prisma');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function verifyTokenAndGetUser(authHeader) {
  if (!authHeader) return null;
  const [type, token] = authHeader.split(' ');
  if (type !== 'Bearer' || !token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function ensureDriverForUser(user) {
  let driver = await prisma.driver.findUnique({ where: { supabaseUserId: user.id } });
  if (!driver) {
    driver = await prisma.driver.create({ data: { supabaseUserId: user.id, name: user.user_metadata?.full_name || user.email || 'Driver' } });
  }
  return driver;
}

async function authMiddleware(req, res, next) {
  try {
    const user = await verifyTokenAndGetUser(req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    req.driver = await ensureDriverForUser(user);
    next();
  } catch (e) {
    next(e);
  }
}

async function socketAuth(socket, next) {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
    if (!token) return next(new Error('Unauthorized'));
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return next(new Error('Unauthorized'));
    const driver = await ensureDriverForUser(data.user);
    socket.data.user = data.user;
    socket.data.driver = driver;
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { authMiddleware, socketAuth };
