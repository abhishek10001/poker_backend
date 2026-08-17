import { generateGameId, generatePlayerId, generateSessionToken } from '../utils/idGenerator.js';
import GameRoom from '../models/GameRoom.js';
import Player from '../models/Player.js';
import turnTimer from './turnTimer.js';

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.redisClient = null;
  }

  setRedisClient(redis) {
    this.redisClient = redis;
  }

  async createRoom(hostDisplayName, config, hostBuyIn) {
    const gameId = generateGameId();
    const hostPlayerId = generatePlayerId();
    
    const room = new GameRoom(gameId, hostPlayerId, config);
    const hostWallet = (hostBuyIn && hostBuyIn > 0) ? hostBuyIn : Math.max(1000, (config?.bootAmount || 100) * 10);
    const hostPlayer = new Player(hostPlayerId, hostDisplayName, hostWallet);
    room.addPlayer(hostPlayer);
    
    this.rooms.set(gameId, room);
    
    // In production we would serialize and save to Redis, but for memory it's just setting status
    if (this.redisClient) {
      await this.redisClient.hset(`room:${gameId}`, 'status', 'active');
    }
    
    const sessionToken = await this.generateSessionToken(hostPlayerId, gameId);
    
    return { gameId, hostPlayerId, sessionToken, hostWallet };
  }

  async joinRoom(gameId, displayName, buyInAmount, requestedPlayerId) {
    const room = this.rooms.get(gameId);
    if (!room) throw new Error('Room not found');

    const cleanName = displayName.trim().toLowerCase();

    // Check if player already exists in the room (reconnection flow)
    let existingPlayer = null;
    if (requestedPlayerId && room.players.has(requestedPlayerId)) {
      existingPlayer = room.players.get(requestedPlayerId);
    } else {
      for (const p of room.players.values()) {
        if (p.displayName.trim().toLowerCase() === cleanName) {
          existingPlayer = p;
          break;
        }
      }
    }

    if (existingPlayer) {
      existingPlayer.connected = true;
      const sessionToken = await this.generateSessionToken(existingPlayer.playerId, gameId);
      return {
        playerId: existingPlayer.playerId,
        sessionToken,
        gameId,
        phase: room.phase,
        config: room.config,
        reconnected: true,
        player: existingPlayer.toJSON(),
      };
    }
    
    if (room.players.size >= room.config.maxPlayers) {
      throw new Error('Room is full');
    }
    
    const playerId = requestedPlayerId || generatePlayerId();
    const initialWallet = (buyInAmount && buyInAmount > 0) ? buyInAmount : 1000;
    const player = new Player(playerId, displayName.trim(), initialWallet);
    if (room.phase !== 'LOBBY') {
      player.status = 'waiting';
    }
    room.addPlayer(player);
    
    const sessionToken = await this.generateSessionToken(playerId, gameId);
    return {
      playerId,
      sessionToken,
      gameId,
      phase: room.phase,
      config: room.config,
      reconnected: false,
      player: player.toJSON(),
    };
  }

  getRoom(gameId) {
    return this.rooms.get(gameId);
  }

  async removeRoom(gameId) {
    this.rooms.delete(gameId);
    turnTimer.clearTimer(gameId);
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
