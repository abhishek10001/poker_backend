import roomManager from '../services/roomManager.js';

/**
 * Socket.IO authentication middleware.
 * Validates session tokens from handshake auth against Redis session store.
 * 
 * Expected handshake.auth: { sessionToken, gameId, playerId }
 */
export default async function socketAuthMiddleware(socket, next) {
  try {
    const { sessionToken, gameId, playerId } = socket.handshake.auth || {};

    if (!sessionToken || !gameId || !playerId) {
      return next(new Error('Authentication required: missing sessionToken, gameId, or playerId'));
    }

    // Validate the session token against Redis store
    const isValid = await roomManager.validateSession(gameId, playerId, sessionToken);
    if (!isValid) {
      return next(new Error('Invalid session token'));
    }

    // Verify the room exists and the player is in it
    const room = roomManager.getRoom(gameId);
    if (!room) {
      return next(new Error('Room not found'));
    }

    const player = room.players.get(playerId);
    if (!player) {
      return next(new Error('Player not found in room'));
    }

    // Attach data to socket for use in handlers
    socket.data.gameId = gameId;
    socket.data.playerId = playerId;
    socket.data.displayName = player.displayName;

    next();
  } catch (err) {
    next(new Error(`Authentication failed: ${err.message}`));
  }
}
