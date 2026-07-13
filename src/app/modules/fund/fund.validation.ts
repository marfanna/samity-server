import { z } from 'zod';

const policySchema = z.object({
  cycleUnit: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  startDate: z.coerce.date(),
  collectionWeekday: z.number().int().min(1).max(7).optional(), // WEEKLY only: 1=Mon…7=Sun

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

// ── Existing-fund import (Phase 15) ────────────────────────────────────────
const e164 = z
  .string()
  .trim()
  .regex(/^\+\d{8,15}$/, 'phone must be E.164');

const importMemberSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: e164,
  shares: z.number().int().positive('shares must be > 0'),
  // how many cycles this member is behind on dues right now (0 = current)
  cyclesBehind: z.number().int().min(0).default(0),
});

const importInvestmentSchema = z.object({
  destination: z.string().trim().min(1).max(120),
  amountCost: intPaisa.positive('investment cost must be > 0'),
  expectedReturn: intPaisa.min(0).default(0),
  expectedDate: z.coerce.date().optional(),
});

export const importFundSchema = z.object({
  name: z.string().trim().min(1).max(80),
  faceValue: intPaisa.positive('face value must be > 0'),
  policy: policySchema, // startDate = the samiti's REAL original start (cycle anchor)
  // the caller (admin) is a member too — their own holding/arrears
  adminShares: z.number().int().positive('admin shares must be > 0'),
  adminCyclesBehind: z.number().int().min(0).default(0),
  // fund liquid cash on hand now (net of money already out in investments)
  openingCashPaisa: intPaisa.min(0).default(0),
  members: z.array(importMemberSchema).default([]),
  investments: z.array(importInvestmentSchema).default([]),
  successorPhone: e164.optional(),
});

export type ImportFundInput = z.infer<typeof importFundSchema>;
export type ImportMemberInput = z.infer<typeof importMemberSchema>;

const bankDetailsSchema = z.object({
  accountName: z.string().trim().max(120).optional(),
  accountNumber: z.string().trim().max(60).optional(),
  bankName: z.string().trim().max(80).optional(),
  branch: z.string().trim().max(80).optional(),
  instructions: z.string().trim().max(300).optional(),
});

// Editable policy fields only — cycleUnit + startDate are immutable after creation
export const updateFundSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  visibility: z.enum(['PUBLIC', 'INVITE_ONLY']).optional(),
  shareChange: z.enum(['FIXED', 'BUY_AT_NAV', 'BOTH']).optional(),
  nonPayment: z.enum(['TRACK_ONLY', 'PENALTY', 'AUTO_SUSPEND']).optional(),
  joinLock: z.enum(['BLOCK_DURING_INVESTMENT', 'ALLOW']).optional(),
  graceCycles: z.number().int().min(0).optional(),
  penaltyPaisa: z.number().int().min(0).optional(),
  suspendAfterMisses: z.number().int().min(0).optional(),
  inactivityDays: z.number().int().min(1).optional(),
  collectionWeekday: z.number().int().min(1).max(7).optional(),
  bankDetails: bankDetailsSchema.optional(),
});

export type UpdateFundInput = z.infer<typeof updateFundSchema>;

export const changeMemberRoleSchema = z.object({
  role: z.enum(['moderator', 'member']),
});

export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleSchema>;

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'invalid id');

export const transferOwnershipSchema = z.object({
  membershipId: objectId,
});

export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
