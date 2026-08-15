import roomManager from '../services/roomManager.js';
import gameEngine from '../services/gameEngine.js';
import turnTimer from '../services/turnTimer.js';
import { playerActionSchema } from '../utils/validator.js';

/** @type {Map<string, NodeJS.Timeout>} Grace period timers for disconnected players */
const disconnectTimers = new Map();

/**
 * Sets up all Socket.IO event handlers for a connected socket.
 * @param {import('socket.io').Server} io - The Socket.IO server instance
 * @param {import('socket.io').Socket} socket - The connected socket
 */
export function setupSocketHandlers(io, socket) {
  const { gameId, playerId, displayName } = socket.data;

  // ─── On Connection: Join room + handle reconnect ───
  const room = roomManager.getRoom(gameId);
  if (room) {
    socket.join(gameId);

    const player = room.players.get(playerId);
    if (player) {
      player.connected = true;
      player.socketId = socket.id;
    }

    // Cancel any pending disconnect grace period
    const timerKey = `${gameId}:${playerId}`;
    if (disconnectTimers.has(timerKey)) {
      clearTimeout(disconnectTimers.get(timerKey));
      disconnectTimers.delete(timerKey);
      // This is a reconnect
      socket.to(gameId).emit('playerReconnected', { playerId, displayName });
    } else {
      // Fresh join — notify room
      socket.to(gameId).emit('playerJoined', {
        playerId,
        displayName,
        wallet: player ? player.wallet : 0,
      });
    }

    // Send full state sync to the connecting/reconnecting client
    socket.emit('stateSync', room.getFullState());
  }

  // ─── Player Action (Blind, Seen, Chaal, Raise, Pack, Show) ───
  socket.on('playerAction', (data) => {
    try {
      const parsed = playerActionSchema.parse(data);
      const room = roomManager.getRoom(gameId);
      if (!room) {
        return socket.emit('error', { message: 'Room not found', code: 'ROOM_NOT_FOUND' });
      }

      const result = gameEngine.processPlayerAction(room, playerId, parsed, io);

      // Reset turn timer after successful action (if game still in betting phase)
      if (room.phase === 'BETTING') {
        turnTimer.resetTimer(gameId, room, io);
      } else {
        turnTimer.clearTimer(gameId);
      }
    } catch (err) {
      socket.emit('error', { message: err.message, code: 'ACTION_ERROR' });
    }
  });

  // ─── Start Round (Host Only) ───
  socket.on('startRound', () => {
    try {
      const room = roomManager.getRoom(gameId);
      if (!room) {
        return socket.emit('error', { message: 'Room not found', code: 'ROOM_NOT_FOUND' });
      }
      if (room.hostId !== playerId) {
        return socket.emit('error', { message: 'Only the host can start a round', code: 'NOT_HOST' });
      }

      gameEngine.startNewRound(room, io);

      // Start the turn timer
      turnTimer.startTimer(gameId, room, io, room.config.turnTimerSeconds * 1000);
    } catch (err) {
      socket.emit('error', { message: err.message, code: 'START_ROUND_ERROR' });
    }
  });

  // ─── Declare Winner ───
  socket.on('declareWinner', (data) => {
    try {
      const { winnerId } = data || {};
      if (!winnerId) {
        return socket.emit('error', { message: 'winnerId is required', code: 'INVALID_INPUT' });
      }

      const room = roomManager.getRoom(gameId);
      if (!room) {
        return socket.emit('error', { message: 'Room not found', code: 'ROOM_NOT_FOUND' });
      }

      gameEngine.declareWinner(room, winnerId, io);
      turnTimer.clearTimer(gameId);
    } catch (err) {
      socket.emit('error', { message: err.message, code: 'DECLARE_WINNER_ERROR' });
    }
  });

  // ─── Request Top-Up ───
  socket.on('requestTopUp', (data) => {
    try {
      const { amount } = data || {};
      if (!amount || amount <= 0) {
        return socket.emit('error', { message: 'Valid amount is required', code: 'INVALID_INPUT' });
      }

      const room = roomManager.getRoom(gameId);
      if (!room) return;

      // Find host's socket and send them the request
      const hostPlayer = room.players.get(room.hostId);
      if (hostPlayer && hostPlayer.socketId) {
        io.to(hostPlayer.socketId).emit('topUpRequested', {
          playerId,
          displayName,
          amount,
        });
      }
    } catch (err) {
      socket.emit('error', { message: err.message, code: 'TOPUP_REQUEST_ERROR' });
    }
  });

  // ─── Approve Top-Up (Host Only) ───
  socket.on('approveTopUp', (data) => {
    try {
      const { playerId: targetPlayerId, amount } = data || {};
      if (!targetPlayerId || !amount || amount <= 0) {
        return socket.emit('error', { message: 'playerId and valid amount required', code: 'INVALID_INPUT' });
      }

      const room = roomManager.getRoom(gameId);
      if (!room) return;

      if (room.hostId !== playerId) {
        return socket.emit('error', { message: 'Only the host can approve top-ups', code: 'NOT_HOST' });
      }

      const targetPlayer = room.players.get(targetPlayerId);
      if (!targetPlayer) {
        return socket.emit('error', { message: 'Target player not found', code: 'PLAYER_NOT_FOUND' });
      }

      targetPlayer.credit(amount);
      targetPlayer.totalBuyIn += amount;

      io.to(gameId).emit('topUpApproved', {
        playerId: targetPlayerId,
        displayName: targetPlayer.displayName,
        amount,
        newWallet: targetPlayer.wallet,
      });
    } catch (err) {
      socket.emit('error', { message: err.message, code: 'TOPUP_APPROVE_ERROR' });
    }
  });

  // ─── Leave Room ───
  socket.on('leaveRoom', () => {
    const room = roomManager.getRoom(gameId);
    if (!room) return;

    const timerKey = `${gameId}:${playerId}`;
    if (disconnectTimers.has(timerKey)) {
      clearTimeout(disconnectTimers.get(timerKey));
      disconnectTimers.delete(timerKey);
    }

    if (room.hostId === playerId) {
      io.to(gameId).emit('roomDissolved', { message: 'Host left the lobby' });
      roomManager.removeRoom(gameId);
    } else {
      room.removePlayer(playerId);
      io.to(gameId).emit('playerLeft', { playerId, displayName, reason: 'left_room' });
    }
    socket.leave(gameId);
  });

  // ─── Disconnect Handling ───
  socket.on('disconnect', (reason) => {
    const room = roomManager.getRoom(gameId);
    if (!room) return;

    const player = room.players.get(playerId);
    if (!player) return;

    player.connected = false;
    player.socketId = null;

    // Notify room that player connection dropped, but keep them in the room
    // until they explicitly leave.
    io.to(gameId).emit('playerDisconnected', { playerId, displayName });

    // Start 2-minute grace period
    const timerKey = `${gameId}:${playerId}`;
    const gracePeriod = 2 * 60 * 1000; // 2 minutes

    const timer = setTimeout(() => {
      disconnectTimers.delete(timerKey);

      const currentRoom = roomManager.getRoom(gameId);
      if (!currentRoom) return;

      const disconnectedPlayer = currentRoom.players.get(playerId);
      if (!disconnectedPlayer || disconnectedPlayer.connected) return;

      // If it's their turn, auto-pack
      if (
        currentRoom.phase === 'BETTING' &&
        currentRoom.turnOrder[currentRoom.currentTurnIndex] === playerId
      ) {
        try {
          currentRoom.processAction(playerId, { action: 'PACK' });
          io.to(gameId).emit('playerAction', {
            playerId,
            displayName,
            action: 'PACK',
            amount: 0,
            pot: currentRoom.pot,
            currentStake: currentRoom.currentStake,
            autoAction: true,
            reason: 'disconnect_timeout',
            wallets: Object.fromEntries(
              Array.from(currentRoom.players.entries()).map(([id, p]) => [id, p.wallet])
            ),
          });

          // Check for auto-win after pack
          if (currentRoom.phase === 'SETTLEMENT') {
            const winner = currentRoom.getActivePlayers()[0];
            if (winner) {
              io.to(gameId).emit('roundSettled', {
                winnerId: winner.playerId,
                potAmount: 0, // pot already distributed
                wallets: Object.fromEntries(
                  Array.from(currentRoom.players.entries()).map(([id, p]) => [id, p.wallet])
                ),
              });
            }
          } else if (currentRoom.phase === 'BETTING') {
            const nextPlayerId = currentRoom.turnOrder[currentRoom.currentTurnIndex];
            io.to(gameId).emit('turnChanged', {
              playerId: nextPlayerId,
              legalActions: currentRoom.getLegalActions(nextPlayerId),
              timeoutSeconds: currentRoom.config.turnTimerSeconds,
            });
            turnTimer.resetTimer(gameId, currentRoom, io);
          }
        } catch (err) {
          console.error(`Auto-pack on disconnect timeout failed: ${err.message}`);
        }
      }

      // Keep player in room after timeout; they remain disconnected and can rejoin.
    }, gracePeriod);

    disconnectTimers.set(timerKey, timer);
  });
}
