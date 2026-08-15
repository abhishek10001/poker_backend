import { z } from 'zod';

export const createRoomSchema = z.object({
  hostDisplayName: z.string().min(1).max(50),
  config: z.object({
    bootAmount: z.number().positive(),
    maxRaiseMultiplier: z.number().positive(),
    maxPlayers: z.number().int().min(2).max(10),
    turnTimerSeconds: z.number().int().min(10).max(120),
    chipLabel: z.string().default('Chips')
  })
});

export const joinRoomSchema = z.object({
  displayName: z.string().min(1).max(50),
  buyInAmount: z.number().positive()
});

export const playerActionSchema = z.object({
  action: z.enum(['BLIND', 'SEEN', 'CHAAL', 'RAISE', 'PACK', 'SHOW']),
  amount: z.number().positive().optional()
});
