export default class GameRoom {
  constructor(gameId, hostId, config) {
    this.gameId = gameId;
    this.hostId = hostId;
    this.config = {
      bootAmount: config.bootAmount || 10,
      maxRaiseMultiplier: config.maxRaiseMultiplier || 100,
      maxPlayers: config.maxPlayers || 6,
      turnTimerSeconds: config.turnTimerSeconds || 30,
      chipLabel: config.chipLabel || 'Chips'
    };
    this.phase = 'LOBBY';
    this.players = new Map();
    this.pot = 0;
    this.currentStake = 0;
    this.turnOrder = [];
    this.currentTurnIndex = -1;
    this.actionLog = [];
    this.roundNumber = 0;
  }

  addPlayer(player) {
    if (this.players.size >= this.config.maxPlayers) {
      throw new Error('Room is full');
    }
    this.players.set(player.playerId, player);
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    this.turnOrder = this.turnOrder.filter(id => id !== playerId);
  }

  startRound() {
    if (this.players.size < 2) {
      throw new Error('Need at least 2 players to start a round');
    }
    this.phase = 'BETTING';
    this.roundNumber++;
    this.pot = 0;
    this.currentStake = this.config.bootAmount;
    this.turnOrder = [];
    this.actionLog = [];

    // Setup active players and deduct boot
    for (const [id, player] of this.players.entries()) {
      if (player.connected && player.wallet >= this.config.bootAmount) {
        player.status = 'blind';
        player.deduct(this.config.bootAmount);
        this.pot += this.config.bootAmount;
        this.turnOrder.push(id);
      } else {
        player.status = 'waiting';
      }
    }

    if (this.turnOrder.length < 2) {
      throw new Error('Not enough players have sufficient funds for boot amount');
    }
    
    // Dealer/Turn logic could be more complex, but we'll just start at 0
    this.currentTurnIndex = 0;
  }

  processAction(playerId, actionObj) {
    const { action, amount } = actionObj;
    
    if (this.phase !== 'BETTING') throw new Error('Not in betting phase');
    if (this.turnOrder[this.currentTurnIndex] !== playerId) throw new Error('Not your turn');
    
    const legalActions = this.getLegalActions(playerId);
    if (!legalActions.includes(action)) throw new Error(`Action ${action} is not legal right now`);

    const player = this.players.get(playerId);
    const startPot = this.pot;

    switch (action) {
      case 'BLIND':
        this.handleBlind(playerId);
        break;
      case 'SEEN':
        this.handleSeen(playerId);
        return { action, pot: this.pot }; // SEEN does not advance turn, just status update
      case 'CHAAL':
        this.handleChaal(playerId);
        break;
      case 'RAISE':
        this.handleRaise(playerId, amount);
        break;
      case 'PACK':
        this.handlePack(playerId);
        break;
      case 'SHOW':
        this.handleShow(playerId);
        break;
      default:
        throw new Error('Unknown action');
    }

    this.actionLog.push({ playerId, action, amount, timestamp: Date.now() });

    // Check auto-win
    const active = this.getActivePlayers();
    if (active.length === 1 && this.phase === 'BETTING') {
      this.declareWinner(active[0].playerId);
    } else if (action !== 'SHOW') {
      this.advanceTurn();
    }

    return { action, pot: this.pot, delta: this.pot - startPot };
  }

  getLegalActions(playerId) {
    const player = this.players.get(playerId);
    if (!player || !player.isActive()) return [];

    const actions = ['PACK']; // Can always pack
    
    if (player.status === 'blind') {
      actions.push('BLIND');  // Bet blind (1x stake)
      actions.push('SEEN');   // Look at cards (status change only)
      actions.push('CHAAL');  // Call as blind (1x stake)
    } else if (player.status === 'seen') {
      actions.push('CHAAL');  // Call as seen (2x stake)
    }

    // Raise available for both blind and seen, within multiplier limit
    if (this.currentStake < this.config.bootAmount * this.config.maxRaiseMultiplier) {
      if (player.status === 'blind' || player.status === 'seen') {
        actions.push('RAISE');
      }
    }

    const activePlayers = this.getActivePlayers();
    if (activePlayers.length === 2) {
      actions.push('SHOW');
    }

    return actions;
  }

  handleBlind(playerId) {
    const player = this.players.get(playerId);
    const cost = this.currentStake;
    player.deduct(cost);
    this.pot += cost;
  }

  handleSeen(playerId) {
    const player = this.players.get(playerId);
    player.status = 'seen';
  }

  handleChaal(playerId) {
    const player = this.players.get(playerId);
    const cost = this.currentStake;
    player.deduct(cost);
    this.pot += cost;
  }

  handleRaise(playerId, newStake) {
    if (!newStake || newStake <= this.currentStake) {
      throw new Error('New stake must be greater than current stake');
    }
    if (newStake > this.config.bootAmount * this.config.maxRaiseMultiplier) {
      throw new Error('Raise exceeds maximum multiplier');
    }
    const player = this.players.get(playerId);
    this.currentStake = newStake;
    const cost = this.currentStake;
    player.deduct(cost);
    this.pot += cost;
  }

  handlePack(playerId) {
    const player = this.players.get(playerId);
    player.status = 'packed';
  }

  handleShow(playerId) {
    const player = this.players.get(playerId);
    const cost = player.status === 'blind' ? this.currentStake : this.currentStake * 2;
    player.deduct(cost);
    this.pot += cost;
    this.phase = 'SHOWDOWN';
  }

  declareWinner(winnerId) {
    const winner = this.players.get(winnerId);
    const potAmount = this.pot;  // capture before zeroing
    if (winner) {
      winner.credit(this.pot);
    }
    this.pot = 0;  // explicitly zero pot after crediting
    this.phase = 'SETTLEMENT';
    return potAmount;  // return so callers can use it
  }

  advanceTurn() {
    let attempts = 0;
    const total = this.turnOrder.length;
    while (attempts < total) {
      this.currentTurnIndex = (this.currentTurnIndex + 1) % total;
      const nextPlayerId = this.turnOrder[this.currentTurnIndex];
      const nextPlayer = this.players.get(nextPlayerId);
      if (nextPlayer && nextPlayer.isActive()) {
        return;
      }
      attempts++;
    }
    throw new Error('No active players left to take a turn');
  }

  getActivePlayers() {
    return Array.from(this.players.values()).filter(p => p.isActive());
  }

  getBankruptPlayers() {
    return Array.from(this.players.values()).filter(
      p => p.connected && p.wallet < this.config.bootAmount
    );
  }

  getFullState() {
    return {
      gameId: this.gameId,
      hostId: this.hostId,
      config: this.config,
      phase: this.phase,
      pot: this.pot,
      currentStake: this.currentStake,
      turnOrder: this.turnOrder,
      currentTurnIndex: this.currentTurnIndex,
      roundNumber: this.roundNumber,
      players: Object.fromEntries(
        Array.from(this.players.entries()).map(([k, v]) => [
          k,
          {
            ...v.toJSON(),
            isHost: k === this.hostId,
          }
        ])
      )
    };
  }

  getDelta(action, result) {
    return {
      phase: this.phase,
      pot: this.pot,
      currentStake: this.currentStake,
      currentTurnIndex: this.currentTurnIndex,
      lastAction: { action, result }
    };
  }

  resetForNewRound() {
    this.pot = 0;
    this.currentStake = 0;
    this.currentTurnIndex = -1;
    this.turnOrder = [];
    this.actionLog = [];
    this.phase = 'LOBBY';
    for (const player of this.players.values()) {
      player.status = 'waiting';
    }
  }
}
