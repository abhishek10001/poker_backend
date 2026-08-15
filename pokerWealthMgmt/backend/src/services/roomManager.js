import { generateGameId, generatePlayerId, generateSessionToken } from '../utils/idGenerator.js';
import GameRoom from '../models/GameRoom.js';
import Player from '../models/Player.js';

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.redisClient = null;
  }

  setRedisClient(redis) {
    this.redisClient = redis;
  }

  async createRoom(hostDisplayName, config) {
    const gameId = generateGameId();
    const hostPlayerId = generatePlayerId();
    
    const room = new GameRoom(gameId, hostPlayerId, config);
    const hostWallet = Math.max(1000, (config?.bootAmount || 100) * 10);
    const hostPlayer = new Player(hostPlayerId, hostDisplayName, hostWallet);
    room.addPlayer(hostPlayer);
    
    this.rooms.set(gameId, room);
    
    // In production we would serialize and save to Redis, but for memory it's just setting status
    if (this.redisClient) {
      await this.redisClient.hset(`room:${gameId}`, 'status', 'active');
    }
    
    const sessionToken = await this.generateSessionToken(hostPlayerId, gameId);
    
    return { gameId, hostPlayerId, sessionToken };
  }

  async joinRoom(gameId, displayName, buyInAmount) {
    const room = this.rooms.get(gameId);
    if (!room) throw new Error('Room not found');
    
    if (room.players.size >= room.config.maxPlayers) {
      throw new Error('Room is full');
    }
    
    const playerId = generatePlayerId();
    const player = new Player(playerId, displayName, buyInAmount);
    room.addPlayer(player);
    
    const sessionToken = await this.generateSessionToken(playerId, gameId);
    return { playerId, sessionToken };
  }

  getRoom(gameId) {
    return this.rooms.get(gameId);
  }

  async removeRoom(gameId) {
    this.rooms.delete(gameId);
    if (this.redisClient) {
      await this.redisClient.del(`room:${gameId}`);
      await this.redisClient.del(`sessions:${gameId}`);
    }
  }

  async generateSessionToken(playerId, gameId) {
    const token = generateSessionToken();
    if (this.redisClient) {
      await this.redisClient.hset(`sessions:${gameId}`, token, playerId);
      // Optional: set expiry
      await this.redisClient.expire(`sessions:${gameId}`, 86400); 
    }
    return token;
  }

  async validateSession(gameId, playerId, sessionToken) {
    if (!this.redisClient) return true; // fallback if no redis
    const storedPlayerId = await this.redisClient.hget(`sessions:${gameId}`, sessionToken);
    return storedPlayerId === playerId;
  }

  setupIdleTimeout(gameId, io) {
    // Basic implementation of idle timeout
    // Left simple for this version
  }
}

export default new RoomManager();
