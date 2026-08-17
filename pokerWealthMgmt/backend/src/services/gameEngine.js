/**
 * Game Engine — Orchestrator between GameRoom state machine, Socket.IO broadcasting, and turn timers.
 * All game logic flows through here: action processing, round management, and winner declaration.
 */

class GameEngine {
  /**
   * Process a player's betting action and broadcast the result to the room.
   * @param {import('../models/GameRoom.js').default} room - The game room
   * @param {string} playerId - The acting player's ID
   * @param {Object} actionObj - { action: string, amount?: number }
   * @param {import('socket.io').Server} io - Socket.IO server
   * @returns {Object} The action result
   */
  processPlayerAction(room, playerId, actionObj, io, options = {}) {
    const player = room.players.get(playerId);
    if (!player) throw new Error('Player not found');

    // Capture pot before action (in case auto-win zeros it)
    const potBeforeAction = room.pot;

    const result = room.processAction(playerId, actionObj);

    // Build wallet snapshot
    const wallets = {};
    for (const [id, p] of room.players.entries()) {
      wallets[id] = p.wallet;
    }

    const actionAmount = (actionObj.action === 'PACK' || actionObj.action === 'SEEN') ? 0 : (result.delta > 0 ? result.delta : 0);
    const settledPotAmount = potBeforeAction + actionAmount;

    // Broadcast the action to the entire room
    io.to(room.gameId).emit('playerAction', {
      playerId,
      displayName: player.displayName,
      action: actionObj.action,
      amount: actionAmount,
      pot: room.phase === 'SETTLEMENT' ? settledPotAmount : room.pot,
      currentStake: room.currentStake,
      autoAction: options.autoAction || false,
      reason: options.reason || undefined,
      wallets,
      playerStatus: player.status,
      hasBooted: player.hasBooted,
    });

    // Handle post-action state
    if (room.phase === 'SETTLEMENT') {
      // Auto-win or tie happened (everyone else packed)
      const activePlayers = room.getActivePlayers();
      const winner = activePlayers.length === 1 ? activePlayers[0] : null;
      const isTie = !winner || activePlayers.length === 0;

      io.to(room.gameId).emit('roundSettled', {
        winnerId: winner ? winner.playerId : null,
        displayName: winner ? winner.displayName : (isTie ? 'Split Pot (Tie)' : 'Winner'),
        potAmount: settledPotAmount,
        wallets,
        roundNumber: room.roundNumber,
        isTie: isTie,
      });
    } else if (room.phase === 'SHOWDOWN') {
      // Show was requested — prompt for winner declaration
      const activePlayers = room.getActivePlayers();
      io.to(room.gameId).emit('showdown', {
        players: activePlayers.map(p => ({
          playerId: p.playerId,
          displayName: p.displayName,
          status: p.status,
        })),
        pot: room.pot,
      });
    }

    return result;
  }

  /**
   * Start a new round of betting.
   * @param {import('../models/GameRoom.js').default} room
   * @param {import('socket.io').Server} io
   */
  startNewRound(room, io) {
    // Reset if coming from a previous round
    if (room.phase === 'SETTLEMENT') {
      room.resetForNewRound();
    }

    const connectedPlayers = Array.from(room.players.values()).filter(p => p.connected);
    if (connectedPlayers.length < 2) {
      throw new Error('Need at least 2 connected players to start a round');
    }

    room.startRound();

    // Build wallet snapshot
    const wallets = {};
    for (const [id, p] of room.players.entries()) {
      wallets[id] = p.wallet;
    }

    io.to(room.gameId).emit('roundStarted', {
      roundNumber: room.roundNumber,
      turnOrder: room.turnOrder,
      currentStake: room.currentStake,
      pot: room.pot,
      wallets,
      hostId: room.hostId,
      players: Object.fromEntries(
        Array.from(room.players.entries()).map(([k, v]) => [
          k,
          {
            ...v.toJSON(),
            isHost: k === room.hostId,
          }
        ])
      ),
    });
  }

  /**
   * Declare a winner and settle the round.
   * @param {import('../models/GameRoom.js').default} room
   * @param {string} winnerId
   * @param {import('socket.io').Server} io
   */
  declareWinner(room, winnerId, io) {
    const winner = room.players.get(winnerId);
    if (!winner) throw new Error('Winner not found in room');

    const potAmount = room.declareWinner(winnerId);  // now returns pot amount

    // Build wallet snapshot
    const wallets = {};
    for (const [id, p] of room.players.entries()) {
      wallets[id] = p.wallet;
    }

    io.to(room.gameId).emit('roundSettled', {
      winnerId,
      displayName: winner.displayName,
      potAmount,
      wallets,
      roundNumber: room.roundNumber,
      isTie: false,
    });
  }

  /**
   * Declare a tie and split the pot equally among active players.
   * @param {import('../models/GameRoom.js').default} room
   * @param {import('socket.io').Server} io
   */
  declareTie(room, io) {
    const activePlayers = room.getActivePlayers();
    const potAmount = room.declareTie();

    // Build wallet snapshot
    const wallets = {};
    for (const [id, p] of room.players.entries()) {
      wallets[id] = p.wallet;
    }

    io.to(room.gameId).emit('roundSettled', {
      winnerId: null,
      displayName: 'Split Pot (Tie)',
      isTie: true,
      potAmount,
      wallets,
      roundNumber: room.roundNumber,
      splitAmong: activePlayers.map(p => p.displayName),
    });
  }

  /**
   * Broadcast whose turn it is, along with their legal actions and timer info.
   * @param {import('../models/GameRoom.js').default} room
   * @param {import('socket.io').Server} io
   */
  broadcastTurnChange(room, io) {
    const currentPlayerId = room.turnOrder[room.currentTurnIndex];
    if (!currentPlayerId) return;

    const legalActions = room.getLegalActions(currentPlayerId);

    io.to(room.gameId).emit('turnChanged', {
      playerId: currentPlayerId,
      legalActions,
      timeoutSeconds: room.config.turnTimerSeconds,
    });
  }
}

export default new GameEngine();
