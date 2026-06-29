import { z } from 'zod';

const intPaisa = z.number().int('must be integer paisa').min(1);

export const recordInvestmentSchema = z.object({
  destination: z.string().trim().min(1).max(200),
  amountCost: intPaisa,
  expectedReturn: intPaisa.optional(),
  expectedDate: z.string().datetime().optional(),
});

export const recordReturnSchema = z.object({
  actualReturn: intPaisa,
  screenshotUrl: z.string().trim().min(1),
});

export type RecordInvestmentInput = z.infer<typeof recordInvestmentSchema>;
export type RecordReturnInput = z.infer<typeof recordReturnSchema>;
