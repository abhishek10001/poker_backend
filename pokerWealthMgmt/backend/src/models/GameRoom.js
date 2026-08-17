export default class GameRoom {
  constructor(gameId, hostId, config) {
    this.gameId = gameId;
    this.hostId = hostId;
    this.config = {
      bootAmount: config.bootAmount || 10,
      maxRaiseMultiplier: config.maxRaiseMultiplier || 4,
      maxPlayers: config.maxPlayers || 6,
      turnTimerSeconds: config.turnTimerSeconds || 30,
      chipLabel: config.chipLabel || '₹'
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
    this.turnOrder = Array.from(this.players.keys());
    this.actionLog = [];

    // Reset player state for new round — players boot manually via Boot button
    for (const [, player] of this.players.entries()) {
      if (player.connected) {
        player.hasBooted = false;
        player.status = 'waiting';
      }
    }
  }

  processAction(playerId, actionObj) {
    const { action, amount, targetPlayerId } = actionObj;
    
    if (this.phase !== 'BETTING') throw new Error('Not in betting phase');
    
    const player = this.players.get(playerId);
    if (!player) throw new Error('Player not found');

    const legalActions = this.getLegalActions(playerId);
    if (!legalActions.includes(action)) throw new Error(`Action ${action} is not legal right now`);

    const startPot = this.pot;

    switch (action) {
      case 'BOOT':
        this.handleBoot(playerId);
        break;
      case 'BLIND':
        this.handleBlind(playerId);
        break;
      case 'SEEN':
        this.handleSeen(playerId);
        return { action, pot: this.pot, delta: 0 };
      case 'CHAAL':
        this.handleChaal(playerId);
        break;
      case 'RAISE':
        this.handleRaise(playerId, amount);
        break;
      case 'ALL_IN':
        this.handleAllIn(playerId);
        break;
      case 'BACK_SHOW':
        this.handleBackShow(playerId, targetPlayerId);
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

    // Check auto-win / settlement if players have packed
    const nonPackedBooted = Array.from(this.players.values()).filter(p => p.hasBooted && p.connected && p.status !== 'packed');
    const allBooted = Array.from(this.players.values()).filter(p => p.hasBooted && p.connected);

    if (this.phase === 'BETTING') {
      if (allBooted.length > 0) {
        if (nonPackedBooted.length === 1 && (allBooted.length > 1 || action === 'PACK')) {
          this.declareWinner(nonPackedBooted[0].playerId);
        } else if (nonPackedBooted.length === 0) {
          this.declareTie();
        }
      } else {
        const nonPacked = Array.from(this.players.values()).filter(p => p.connected && p.status !== 'packed');
        if (nonPacked.length === 1 && action === 'PACK') {
          this.declareWinner(nonPacked[0].playerId);
        } else if (nonPacked.length === 0) {
          this.declareTie();
        }
      }
    }

    return { action, pot: this.pot, delta: this.pot - startPot };
  }

  getLegalActions(playerId) {
    const player = this.players.get(playerId);
    if (!player) return [];

    // If player has not booted yet in this round
    if (!player.hasBooted) {
      if (player.wallet >= this.config.bootAmount) {
        return ['BOOT', 'PACK'];
      }
      return ['PACK'];
    }

    if (!player.isActive()) return [];

    const actions = ['PACK']; // Can always pack
    
    if (player.wallet > 0) {
      actions.push('ALL_IN');
    }

    if (player.status === 'blind') {
      if (player.wallet >= this.currentStake) {
        actions.push('BLIND');  // Bet blind (1x stake)
        actions.push('CHAAL');  // Call as blind (1x stake)
      }
      actions.push('SEEN');   // Look at cards
    } else if (player.status === 'seen') {
      if (player.wallet >= this.currentStake) {
        actions.push('CHAAL');  // Call as seen
      }
    }

    // Raise available within multiplier limit based on CURRENT STAKE
    const maxAllowed = this.currentStake * this.config.maxRaiseMultiplier;
    if (player.wallet > this.currentStake && (player.status === 'blind' || player.status === 'seen')) {
      actions.push('RAISE');
    }

    const activePlayers = this.getActivePlayers();
    if (activePlayers.length >= 2 && player.status === 'seen') {
      actions.push('BACK_SHOW');
    }

    if (activePlayers.length === 2) {
      actions.push('SHOW');
    }

    return actions;
  }

  handleBoot(playerId) {
    const player = this.players.get(playerId);
    if (player.hasBooted) throw new Error('Already booted');
    const cost = this.config.bootAmount;
    player.deduct(cost);
    this.pot += cost;
    player.hasBooted = true;
    player.status = 'blind';
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
    const maxAllowed = this.currentStake * this.config.maxRaiseMultiplier;
    if (newStake > maxAllowed) {
      throw new Error(`Raise exceeds maximum allowed (${maxAllowed})`);
    }
    const player = this.players.get(playerId);
    player.deduct(newStake);
    this.currentStake = newStake;
    this.pot += newStake;
  }

  handleAllIn(playerId) {
    const player = this.players.get(playerId);
    const cost = player.wallet;
    if (cost <= 0) throw new Error('No funds for All-In');
    player.deduct(cost);
    this.pot += cost;
    player.status = 'all_in';
    if (cost > this.currentStake) {
      this.currentStake = cost;
    }
  }

  handleBackShow(playerId, targetPlayerId) {
    const player = this.players.get(playerId);
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
    const cost = this.currentStake;
    player.deduct(cost);
    this.pot += cost;
    this.phase = 'SHOWDOWN';
  }

  addMoney(targetPlayerId, amount) {
    const player = this.players.get(targetPlayerId);
    if (!player) throw new Error('Player not found');
    player.credit(amount);
    player.totalBuyIn += amount;
    return player.wallet;
  }

  declareWinner(winnerId) {
    const winner = this.players.get(winnerId);
    const potAmount = this.pot;
    if (winner) {
      winner.credit(this.pot);
    }
    this.pot = 0;
    this.phase = 'SETTLEMENT';
    return potAmount;
  }

  declareTie() {
    const activePlayers = this.getActivePlayers();
    const potAmount = this.pot;
    if (activePlayers.length > 0) {
      const share = Math.floor(potAmount / activePlayers.length);
      let remainder = potAmount % activePlayers.length;
      for (const p of activePlayers) {
        const creditAmount = share + (remainder > 0 ? 1 : 0);
        p.credit(creditAmount);
        if (remainder > 0) remainder--;
      }
    }
    this.pot = 0;
    this.phase = 'SETTLEMENT';
    return potAmount;
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

  resetForNewRound() {
    this.pot = 0;
    this.currentStake = 0;
    this.currentTurnIndex = -1;
    this.turnOrder = [];
    this.actionLog = [];
    this.phase = 'LOBBY';
    for (const player of this.players.values()) {
      player.status = 'waiting';
      player.hasBooted = false;
    }
  }
}
