import { Router } from 'express';
import roomManager from '../services/roomManager.js';
import { createRoomSchema, joinRoomSchema } from '../utils/validator.js';

const router = Router();

/**
 * POST /api/rooms
 * Create a new game room.
 * 
 * Body: {
 *   hostDisplayName: string,
 *   config: { bootAmount, maxRaiseMultiplier, maxPlayers, turnTimerSeconds, chipLabel }
 * }
 * 
 * Returns: { gameId, playerId, sessionToken }
 */
router.post('/', async (req, res) => {
  try {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { hostDisplayName, config, hostBuyIn } = parsed.data;
    const result = await roomManager.createRoom(hostDisplayName, config, hostBuyIn);

    res.status(201).json({
      gameId: result.gameId,
      playerId: result.hostPlayerId,
      sessionToken: result.sessionToken,
      hostWallet: result.hostWallet,
    });
  } catch (err) {
    console.error('Create room error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/rooms/:gameId/join
 * Join an existing game room.
 * 
 * Body: { displayName: string, buyInAmount?: number, playerId?: string }
 * 
 * Returns: { playerId, sessionToken, gameId, phase, config, reconnected, player }
 */
router.post('/:gameId/join', async (req, res) => {
  try {
    const { gameId } = req.params;

    const parsed = joinRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { displayName, buyInAmount, playerId } = parsed.data;
    const result = await roomManager.joinRoom(gameId, displayName, buyInAmount, playerId);

    res.status(200).json({
      playerId: result.playerId,
      sessionToken: result.sessionToken,
      gameId: result.gameId,
      phase: result.phase,
      config: result.config,
      reconnected: result.reconnected || false,
      player: result.player,
    });
  } catch (err) {
    if (err.message === 'Room not found') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message === 'Room is full') {
      return res.status(409).json({ error: err.message });
    }
    console.error('Join room error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/rooms/:gameId
 * Get public room info (for join screen preview).
 * 
 * Returns: { gameId, playerCount, maxPlayers, config, phase, players }
 */
router.get('/:gameId', (req, res) => {
  try {
    const { gameId } = req.params;
    const room = roomManager.getRoom(gameId);

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const players = Array.from(room.players.values()).map(p => ({
      playerId: p.playerId,
      displayName: p.displayName,
      wallet: p.wallet,
      connected: p.connected,
    }));

    res.json({
      gameId: room.gameId,
      playerCount: room.players.size,
      maxPlayers: room.config.maxPlayers,
      config: room.config,
      phase: room.phase,
      hostId: room.hostId,
      players,
    });
  } catch (err) {
    console.error('Get room error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
