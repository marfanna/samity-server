import { z } from 'zod';

const phone = z
  .string()
  .trim()
  .regex(/^\+\d{8,15}$/, 'phone must be E.164, e.g. +8801712345678');
const password = z.string().min(6, 'password must be at least 6 characters');
const otp = z.string().regex(/^\d{6}$/, 'otp must be 6 digits');

export const registerSchema = z.object({
  phone,
  name: z.string().trim().min(1).max(80),
  password,
});

export const verifyOtpSchema = z.object({
  phone,
  otp,
  // 'REGISTER' completes signup; absence implies register for the documented flow
  purpose: z.enum(['REGISTER', 'RESET']).default('REGISTER'),
});

export const loginSchema = z.object({ phone, password });

export const forgotSchema = z.object({ phone });

export const resetSchema = z.object({ phone, otp, newPassword: password });

export type RegisterInput = z.infer<typeof registerSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotInput = z.infer<typeof forgotSchema>;
export type ResetInput = z.infer<typeof resetSchema>;
