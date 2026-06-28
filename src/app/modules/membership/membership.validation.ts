import { z } from 'zod';

export const decideJoinSchema = z.object({
  decision: z.enum(['APPROVE', 'DECLINE']),
  reason: z.string().trim().max(200).optional(),
});

export const createInviteSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+\d{8,15}$/, 'phone must be E.164'),
});

export type DecideJoinInput = z.infer<typeof decideJoinSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
