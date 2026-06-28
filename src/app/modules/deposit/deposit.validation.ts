import { z } from 'zod';

const intPaisa = z.number().int('must be integer paisa').min(0);
const positiveInt = z.number().int().min(1);

export const submitDepositSchema = z.object({
  type: z.enum(['BUY_IN', 'REGULAR', 'ADVANCE']),
  amount: intPaisa,
  cyclesCovered: z.number().int().min(0).default(0),
  sharesRequested: z.number().int().min(0).default(0),
  screenshotUrl: z.string().trim().min(1),
  note: z.string().trim().max(500).optional(),
});

export const rejectDepositSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const listDepositsQuerySchema = z.object({
  status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional(),
  limit: positiveInt.max(100).default(20),
});

export type SubmitDepositInput = z.infer<typeof submitDepositSchema>;
export type RejectDepositInput = z.infer<typeof rejectDepositSchema>;
export type ListDepositsQuery = z.infer<typeof listDepositsQuerySchema>;
