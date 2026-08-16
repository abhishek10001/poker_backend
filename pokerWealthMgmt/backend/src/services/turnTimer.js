import gameEngine from './gameEngine.js';

class TurnTimer {
  constructor() {
    this.timers = new Map();
  }

  startTimer(gameId, room, io, timeoutMs) {
    this.clearTimer(gameId);
    if (!room || room.phase !== 'BETTING') return;

    const timeout = setTimeout(() => {
      // Auto-pack player on timeout
      try {
        if (!room || room.phase !== 'BETTING') {
          this.clearTimer(gameId);
          return;
        }

        const currentPlayerId = room.turnOrder[room.currentTurnIndex];
        if (currentPlayerId) {
          console.log(`[TurnTimer] Turn timed out for player ${currentPlayerId} in room ${gameId}. Auto-packing.`);
          
          // Delegate to gameEngine to process PACK action so all events (playerAction, roundSettled, turnChanged)
          // and wallet snapshots are properly broadcast to all clients
          gameEngine.processPlayerAction(room, currentPlayerId, { action: 'PACK' }, io, { autoAction: true });

          // If game is still in betting phase, start timer for next player
          if (room.phase === 'BETTING') {
            this.resetTimer(gameId, room, io);
          } else {
            this.clearTimer(gameId);
          }
        }
      } catch (err) {
        console.error('[TurnTimer] Auto-pack error:', err);
        this.clearTimer(gameId);
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
    if (room && room.phase === 'BETTING') {
      const timeoutMs = (room.config?.turnTimerSeconds || 30) * 1000;
      this.startTimer(gameId, room, io, timeoutMs);
    }
  }
}

export default new TurnTimer();
