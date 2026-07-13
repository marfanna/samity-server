import { z } from 'zod';

export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    locale: z.enum(['bn', 'en']).optional(),
    password: z.string().min(6).optional(),
  })
  .refine((v) => v.name !== undefined || v.locale !== undefined || v.password !== undefined, {
    message: 'nothing to update',
  });

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const fcmTokenSchema = z.object({
  token: z.string().min(1),
});
export type FcmTokenInput = z.infer<typeof fcmTokenSchema>;

export const deleteAccountSchema = z.object({
  password: z.string().min(1),
});
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
