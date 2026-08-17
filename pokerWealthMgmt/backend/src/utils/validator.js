import { z } from 'zod';

export const createRoomSchema = z.object({
  hostDisplayName: z.string().min(1).max(50),
  hostBuyIn: z.number().positive().optional(),
  config: z.object({
    bootAmount: z.number().positive(),
    maxRaiseMultiplier: z.number().positive(),
    maxPlayers: z.number().int().min(2).max(10),
    turnTimerSeconds: z.number().int().min(10).max(120).optional().default(30),
    chipLabel: z.string().default('₹')
  })
});

export const joinRoomSchema = z.object({
  displayName: z.string().min(1).max(50),
  buyInAmount: z.number().positive().optional(),
  playerId: z.string().optional()
});

export const playerActionSchema = z.object({
  action: z.enum(['BOOT', 'BLIND', 'SEEN', 'CHAAL', 'RAISE', 'PACK', 'SHOW', 'ALL_IN', 'BACK_SHOW']),
  amount: z.number().positive().optional(),
  targetPlayerId: z.string().optional()
});

export const hostAddMoneySchema = z.object({
  targetPlayerId: z.string().min(1),
  amount: z.number().positive()
});

export const resolveBackShowSchema = z.object({
  accepted: z.boolean(),
  loserPlayerId: z.string().optional()
});
