import mongoose from 'mongoose';

const GameSessionSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true },
  hostId: { type: String, required: true },
  config: {
    bootAmount: Number,
    maxRaiseMultiplier: Number,
    maxPlayers: Number,
    turnTimerSeconds: Number,
    chipLabel: String
  },
  players: [{
    playerId: String,
    displayName: String,
    initialBuyIn: Number,
    finalBalance: Number,
    netResult: Number
  }],
  rounds: [{
    roundNumber: Number,
    actionLog: Array,
    winnerId: String,
    potSize: Number
  }],
  status: { type: String, enum: ['active', 'completed'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  settlementSummary: mongoose.Schema.Types.Mixed
});

export default mongoose.model('GameSession', GameSessionSchema);
