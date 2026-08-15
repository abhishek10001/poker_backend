export default class Player {
  /**
   * @param {string} playerId
   * @param {string} displayName
   * @param {number} wallet Initial buy-in
   */
  constructor(playerId, displayName, wallet) {
    this.playerId = playerId;
    this.displayName = displayName;
    this.wallet = wallet;
    this.status = 'waiting'; // 'waiting', 'blind', 'seen', 'packed'
    this.connected = true;
    this.totalBuyIn = wallet;
    this.socketId = null;
  }

  toJSON() {
    return {
      playerId: this.playerId,
      displayName: this.displayName,
      wallet: this.wallet,
      status: this.status,
      connected: this.connected,
      totalBuyIn: this.totalBuyIn
    };
  }

  deduct(amount) {
    if (this.wallet < amount) {
      throw new Error('Insufficient funds');
    }
    this.wallet -= amount;
  }

  credit(amount) {
    this.wallet += amount;
  }

  isActive() {
    return this.status !== 'packed' && this.status !== 'waiting';
  }
}
