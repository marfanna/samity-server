import { Schema, model, Types } from 'mongoose';
import { paisa, baseOpts } from '../../../shared/schemaHelpers';

export type CycleUnit = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type Visibility = 'PUBLIC' | 'INVITE_ONLY';
export type ShareChange = 'FIXED' | 'BUY_AT_NAV' | 'BOTH';
export type NonPayment = 'TRACK_ONLY' | 'PENALTY' | 'AUTO_SUSPEND';
export type JoinLock = 'BLOCK_DURING_INVESTMENT' | 'ALLOW';
export type FundStatus = 'ACTIVE' | 'CLOSED';

export interface FundPolicy {
  cycleUnit: CycleUnit;
  startDate: Date; // cycle 0 anchor (Asia/Dhaka)
  visibility: Visibility;
  shareChange: ShareChange;
  nonPayment: NonPayment;
  joinLock: JoinLock;
  graceCycles: number;
  penaltyPaisa: number;
  suspendAfterMisses: number;
  inactivityDays: number;
}

export type FundOrigin = 'NEW' | 'IMPORTED';

/** Where members send their offline contribution. Shown on deposit/buy-in screens. */
export interface BankDetails {
  accountName?: string;
  accountNumber?: string; // bank A/C or bKash/Nagad number
  bankName?: string; // bank name, or "bKash"/"Nagad"
  branch?: string;
  instructions?: string; // free-form note (e.g. "Send as 'Send Money', reference your name")
}

export interface FundDoc {
  _id: Types.ObjectId;
  name: string;
  faceValue: number; // paisa per share
  policy: FundPolicy;
  bankDetails?: BankDetails; // payee info for offline deposits (admin-set)
  createdBy: Types.ObjectId;
  successorUserId?: Types.ObjectId;
  status: FundStatus;
  originType: FundOrigin; // IMPORTED = seeded from an existing samiti's opening balance
  genesisAt?: Date; // when an imported fund's opening balance was recorded
  createdAt: Date;
  updatedAt: Date;
}

const fundPolicySchema = new Schema<FundPolicy>(
  {
    cycleUnit: { type: String, enum: ['DAILY', 'WEEKLY', 'MONTHLY'], required: true },
    startDate: { type: Date, required: true },
    visibility: { type: String, enum: ['PUBLIC', 'INVITE_ONLY'], default: 'INVITE_ONLY' },
    shareChange: { type: String, enum: ['FIXED', 'BUY_AT_NAV', 'BOTH'], default: 'FIXED' },
    nonPayment: { type: String, enum: ['TRACK_ONLY', 'PENALTY', 'AUTO_SUSPEND'], default: 'TRACK_ONLY' },
    joinLock: { type: String, enum: ['BLOCK_DURING_INVESTMENT', 'ALLOW'], default: 'ALLOW' },
    graceCycles: { type: Number, default: 0 },
    penaltyPaisa: paisa({ default: 0 }),
    suspendAfterMisses: { type: Number, default: 3 },
    inactivityDays: { type: Number, default: 30 },
  },
  { _id: false },
);

const bankDetailsSchema = new Schema<BankDetails>(
  {
    accountName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    bankName: { type: String, trim: true },
    branch: { type: String, trim: true },
    instructions: { type: String, trim: true },
  },
  { _id: false },
);

const fundSchema = new Schema<FundDoc>(
  {
    name: { type: String, required: true, trim: true },
    faceValue: paisa({ required: true }),
    policy: { type: fundPolicySchema, required: true },
    bankDetails: { type: bankDetailsSchema },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    successorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['ACTIVE', 'CLOSED'], default: 'ACTIVE' },
    originType: { type: String, enum: ['NEW', 'IMPORTED'], default: 'NEW' },
    genesisAt: { type: Date },
  },
  baseOpts,
);

fundSchema.index({ 'policy.visibility': 1, status: 1 });
fundSchema.index({ createdBy: 1 });

export const Fund = model<FundDoc>('Fund', fundSchema);
