import mongoose from 'mongoose';

const PlayerProfileSchema = new mongoose.Schema({
  playerId: { type: String, required: true, unique: true },
  displayName: String,
  stats: {
    totalGames: { type: Number, default: 0 },
    handsWon: { type: Number, default: 0 },
    biggestPotWon: { type: Number, default: 0 },
    totalNetResult: { type: Number, default: 0 }
  }
});

export default mongoose.model('PlayerProfile', PlayerProfileSchema);
