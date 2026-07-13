import { z } from 'zod';

export const reverseLedgerEntrySchema = z.object({
  reason: z.string().trim().min(1).max(300),
});

export type ReverseLedgerEntryInput = z.infer<typeof reverseLedgerEntrySchema>;
