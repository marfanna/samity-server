import { z } from 'zod';

export const initiateTransferSchema = z.object({
  shares: z.number().int().positive('must transfer at least 1 share'),
  agreedAmount: z.number().int().positive('agreed amount must be > 0'),
  toPhone: z
    .string()
    .trim()
    .regex(/^\+\d{8,15}$/, 'buyer phone must be E.164 format'),
  screenshotUrl: z.string().optional(),
});

export type InitiateTransferInput = z.infer<typeof initiateTransferSchema>;
