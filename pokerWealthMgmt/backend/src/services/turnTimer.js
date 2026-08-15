class TurnTimer {
  constructor() {
    this.timers = new Map();
  }

  startTimer(gameId, room, io, timeoutMs) {
    this.clearTimer(gameId);
    const timeout = setTimeout(() => {
      // Auto-pack player on timeout
      try {
        const currentPlayerId = room.turnOrder[room.currentTurnIndex];
        if (currentPlayerId) {
          room.processAction(currentPlayerId, { action: 'PACK' });
          io.to(gameId).emit('turnTimedOut', { playerId: currentPlayerId });
          
          const active = room.getActivePlayers();
          if (active.length === 1 && room.phase === 'BETTING') {
             // Auto-win is handled by room.processAction, just need to broadcast
             io.to(gameId).emit('roundSettled', { winnerId: active[0].playerId, pot: room.pot });
          } else if (room.phase === 'BETTING') {
             // Broadcast next turn
             const nextPlayerId = room.turnOrder[room.currentTurnIndex];
             io.to(gameId).emit('turnChanged', {
                playerId: nextPlayerId,
                legalActions: room.getLegalActions(nextPlayerId),
                timeoutMs
             });
             this.startTimer(gameId, room, io, timeoutMs);
          }
        }
      } catch (err) {
        console.error('Auto-pack error:', err);
      }
    }, timeoutMs);
    
    this.timers.set(gameId, timeout);
  }

  clearTimer(gameId) {
    if (this.timers.has(gameId)) {
      clearTimeout(this.timers.get(gameId));
      this.timers.delete(gameId);
    }
  }

  resetTimer(gameId, room, io) {
    this.clearTimer(gameId);
    this.startTimer(gameId, room, io, room.config.turnTimerSeconds * 1000);
  }
}

export default new TurnTimer();
