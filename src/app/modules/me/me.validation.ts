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
