import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import cors from 'cors';
import helmet from 'helmet';
import config from './config/index.js';
import roomsRouter from './routes/rooms.js';
import healthRouter from './routes/health.js';
import socketAuthMiddleware from './socket/middleware.js';
import { setupSocketHandlers } from './socket/handlers.js';
import roomManager from './services/roomManager.js';

// ─── Express App ───
const app = express();
app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

// ─── REST Routes ───
app.use('/api/rooms', roomsRouter);
app.use('/health', healthRouter);

// ─── HTTP Server ───
const httpServer = createServer(app);

// ─── Socket.IO Server ───
const io = new Server(httpServer, {
  cors: {
    origin: config.corsOrigin,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
});

// ─── Redis Connection ───
let redisClient = null;

async function connectRedis() {
  try {
    redisClient = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      lazyConnect: true,
    });
    await redisClient.connect();
    console.log('✅ Redis connected');
    roomManager.setRedisClient(redisClient);

    // Optionally set up Redis adapter for Socket.IO horizontal scaling
    // Uncomment when running multiple server instances:
    // const { createAdapter } = await import('@socket.io/redis-adapter');
    // const pubClient = redisClient;
    // const subClient = pubClient.duplicate();
    // await subClient.connect();
    // io.adapter(createAdapter(pubClient, subClient));
    // console.log('✅ Socket.IO Redis adapter configured');
  } catch (err) {
    console.warn('⚠️  Redis connection failed, running without Redis:', err.message);
    console.warn('   Room state will be in-memory only (no persistence across restarts)');
  }
}

// ─── MongoDB Connection ───
async function connectMongo() {
  try {
    await mongoose.connect(config.mongoUri);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.warn('⚠️  MongoDB connection failed, running without persistence:', err.message);
    console.warn('   Game history will not be saved');
  }
}

// ─── Socket.IO Middleware & Handlers ───
io.use(socketAuthMiddleware);

io.on('connection', (socket) => {
  const { gameId, playerId, displayName } = socket.data;
  console.log(`🔌 Socket connected: ${displayName} (${playerId}) → room ${gameId}`);

  setupSocketHandlers(io, socket);

  socket.on('disconnect', (reason) => {
    console.log(`🔌 Socket disconnected: ${displayName} (${playerId}) — reason: ${reason}`);
  });
});

// ─── Start Server ───
async function start() {
  // Connect to databases (non-blocking — server starts even if DBs are down)
  await Promise.allSettled([connectRedis(), connectMongo()]);

  httpServer.listen(config.port, () => {
    console.log(`\n🚀 PotTrack server running on port ${config.port}`);
    console.log(`   Environment: ${config.nodeEnv}`);
    console.log(`   Health check: http://localhost:${config.port}/health`);
    console.log(`   API base: http://localhost:${config.port}/api/rooms\n`);
  });
}

// ─── Graceful Shutdown ───
const shutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Close Socket.IO
  io.close(() => {
    console.log('Socket.IO server closed');
  });

  // Close HTTP server
  httpServer.close(() => {
    console.log('HTTP server closed');
  });

  // Close database connections
  try {
    if (redisClient) {
      await redisClient.quit();
      console.log('Redis connection closed');
    }
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  } catch (err) {
    console.error('Error during shutdown:', err);
  }

  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
