import { z } from 'zod';

const policySchema = z.object({
  cycleUnit: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  startDate: z.coerce.date(),
  visibility: z.enum(['PUBLIC', 'INVITE_ONLY']).default('INVITE_ONLY'),
  shareChange: z.enum(['FIXED', 'BUY_AT_NAV', 'BOTH']).default('FIXED'),
  nonPayment: z.enum(['TRACK_ONLY', 'PENALTY', 'AUTO_SUSPEND']).default('TRACK_ONLY'),
  joinLock: z.enum(['BLOCK_DURING_INVESTMENT', 'ALLOW']).default('ALLOW'),
  graceCycles: z.number().int().min(0).default(0),
  penaltyPaisa: z.number().int().min(0).default(0),
  suspendAfterMisses: z.number().int().min(0).default(3),
  inactivityDays: z.number().int().min(1).default(30),
});

const intPaisa = z.number().int('must be integer paisa');

export const createFundSchema = z.object({
  name: z.string().trim().min(1).max(80),
  faceValue: intPaisa.positive('face value must be > 0'),
  policy: policySchema,
  initialShares: z.number().int().min(0).default(0),
  // successor may be referenced by id (registered) or phone (maybe not registered yet)
  successorUserId: z.string().optional(),
  successorPhone: z
    .string()
    .trim()
    .regex(/^\+\d{8,15}$/, 'successor phone must be E.164')
    .optional(),
});

export type CreateFundInput = z.infer<typeof createFundSchema>;
