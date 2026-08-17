import roomManager from '../services/roomManager.js';
import gameEngine from '../services/gameEngine.js';
import turnTimer from '../services/turnTimer.js';
import { playerActionSchema } from '../utils/validator.js';

/** @type {Map<string, NodeJS.Timeout>} Grace period timers for disconnected players */
const disconnectTimers = new Map();

/**
 * Clear all pending disconnect grace timers for a specific room.
 * @param {string} gameId
 */
function clearRoomDisconnectTimers(gameId) {
  for (const [key, timer] of disconnectTimers.entries()) {
    if (key.startsWith(`${gameId}:`)) {
      clearTimeout(timer);
      disconnectTimers.delete(key);
    }
  }
}

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

  // ─── Player Action (Boot, Blind, Seen, Chaal, Raise, All-In, Back Show, Pack, Show) ───
  socket.on('playerAction', (data) => {
    try {
      const parsed = playerActionSchema.parse(data);
      const room = roomManager.getRoom(gameId);
      if (!room) {
        return socket.emit('error', { message: 'Room not found', code: 'ROOM_NOT_FOUND' });
      }

      const result = gameEngine.processPlayerAction(room, playerId, parsed, io);
      
      if (parsed.action === 'BACK_SHOW') {
        io.to(gameId).emit('backShowRequested', {
          requesterId: playerId,
          displayName: displayName,
          cost: room.currentStake,
        });
      }
    } catch (err) {
      socket.emit('error', { message: err.message, code: 'ACTION_ERROR' });
    }
  });

  // ─── Resolve Back Show ───
  socket.on('resolveBackShow', (data) => {
    try {
      const { accepted, loserPlayerId } = data || {};
      const room = roomManager.getRoom(gameId);
      if (!room) return;

      const wallets = {};
      for (const [id, p] of room.players.entries()) {
        wallets[id] = p.wallet;
      }

      if (accepted && loserPlayerId) {
        const loser = room.players.get(loserPlayerId);
        if (loser) {
          loser.status = 'packed';
          room.actionLog.push({
            playerId: loserPlayerId,
            action: 'PACK',
            amount: 0,
            timestamp: Date.now(),
          });
        }

        const active = room.getActivePlayers();
        if (active.length === 1 && room.phase === 'BETTING') {
          const winnerPot = room.declareWinner(active[0].playerId);
          const updatedWallets = {};
          for (const [id, p] of room.players.entries()) {
            updatedWallets[id] = p.wallet;
          }
          io.to(gameId).emit('roundSettled', {
            winnerId: active[0].playerId,
            displayName: active[0].displayName,
            potAmount: winnerPot,
            wallets: updatedWallets,
            roundNumber: room.roundNumber,
          });
        }

        io.to(gameId).emit('backShowResolved', {
          accepted: true,
          loserPlayerId,
          loserName: loser?.displayName || '',
          wallets,
          players: Object.fromEntries(
            Array.from(room.players.entries()).map(([k, v]) => [k, v.toJSON()])
          ),
        });
      } else {
        io.to(gameId).emit('backShowResolved', {
          accepted: false,
        });
      }
    } catch (err) {
      socket.emit('error', { message: err.message, code: 'RESOLVE_BACK_SHOW_ERROR' });
    }
  });

  // ─── Host Direct Add Money ───
  socket.on('hostAddMoney', (data) => {
    try {
      const { targetPlayerId, amount } = data || {};
      const room = roomManager.getRoom(gameId);
      if (!room) {
        return socket.emit('error', { message: 'Room not found', code: 'ROOM_NOT_FOUND' });
      }
      if (room.hostId !== playerId) {
        return socket.emit('error', { message: 'Only the host can add money', code: 'NOT_HOST' });
      }
      if (!targetPlayerId || !amount || amount <= 0) {
        return socket.emit('error', { message: 'Valid targetPlayerId and amount required', code: 'INVALID_INPUT' });
      }

      const newBalance = room.addMoney(targetPlayerId, Number(amount));
      const targetPlayer = room.players.get(targetPlayerId);

      const wallets = {};
      for (const [id, p] of room.players.entries()) {
        wallets[id] = p.wallet;
      }

      io.to(gameId).emit('topUpApproved', {
        playerId: targetPlayerId,
        displayName: targetPlayer ? targetPlayer.displayName : '',
        amount: Number(amount),
        newWallet: newBalance,
        wallets,
      });
    } catch (err) {
      socket.emit('error', { message: err.message, code: 'HOST_ADD_MONEY_ERROR' });
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
    } catch (err) {
      socket.emit('error', { message: err.message, code: 'START_ROUND_ERROR' });
    }
  });

  // ─── Declare Winner / Tie ───
  socket.on('declareWinner', (data) => {
    try {
      const { winnerId, isTie } = data || {};
      const room = roomManager.getRoom(gameId);
      if (!room) {
        return socket.emit('error', { message: 'Room not found', code: 'ROOM_NOT_FOUND' });
      }
      if (room.hostId !== playerId) {
        return socket.emit('error', { message: 'Only the host can declare a winner', code: 'NOT_HOST' });
      }

      if (isTie) {
        gameEngine.declareTie(room, io);
      } else {
        if (!winnerId) {
          return socket.emit('error', { message: 'winnerId is required', code: 'INVALID_INPUT' });
        }
        gameEngine.declareWinner(room, winnerId, io);
      }
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

      const wallets = {};
      for (const [id, p] of room.players.entries()) {
        wallets[id] = p.wallet;
      }

      io.to(gameId).emit('topUpApproved', {
        playerId: targetPlayerId,
        displayName: targetPlayer.displayName,
        amount,
        newWallet: targetPlayer.wallet,
        wallets,
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
      clearRoomDisconnectTimers(gameId);
      io.to(gameId).emit('roomDissolved', { message: 'Host left the game. Room closed.' });
      roomManager.removeRoom(gameId);
      setTimeout(() => {
        io.in(gameId).socketsLeave(gameId);
      }, 300);
    } else {
      room.removePlayer(playerId);
      io.to(gameId).emit('playerLeft', { playerId, displayName, reason: 'left_room' });
      if (room.players.size === 0) {
        clearRoomDisconnectTimers(gameId);
        roomManager.removeRoom(gameId);
      }
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

    // If host disconnects while in LOBBY phase, dissolve the room immediately
    if (room.phase === 'LOBBY' && room.hostId === playerId) {
      clearRoomDisconnectTimers(gameId);
      io.to(gameId).emit('roomDissolved', { message: 'Host disconnected from lobby' });
      roomManager.removeRoom(gameId);
      setTimeout(() => {
        io.in(gameId).socketsLeave(gameId);
      }, 300);
      return;
    }

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
          gameEngine.processPlayerAction(currentRoom, playerId, { action: 'PACK' }, io, {
            autoAction: true,
            reason: 'disconnect_timeout',
          });

          if (currentRoom.phase === 'BETTING') {
            turnTimer.resetTimer(gameId, currentRoom, io);
          } else {
            turnTimer.clearTimer(gameId);
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
