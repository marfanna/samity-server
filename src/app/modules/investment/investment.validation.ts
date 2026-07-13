import { z } from 'zod';

const intPaisa = z.number().int('must be integer paisa').min(1);

export const recordInvestmentSchema = z.object({
  destination: z.string().trim().min(1).max(200),
  amountCost: intPaisa,
  expectedReturn: intPaisa.optional(),
  expectedDate: z.string().datetime().optional(),
});

export const recordReturnSchema = z.object({
  // min(0), not intPaisa's min(1) — a total loss (nothing came back) must be representable.
  actualReturn: z.number().int('must be integer paisa').min(0),
  screenshotUrl: z.string().trim().min(1),
});

export type RecordInvestmentInput = z.infer<typeof recordInvestmentSchema>;
export type RecordReturnInput = z.infer<typeof recordReturnSchema>;
