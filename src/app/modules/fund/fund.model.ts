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

export interface FundDoc {
  _id: Types.ObjectId;
  name: string;
  faceValue: number; // paisa per share
  policy: FundPolicy;
  createdBy: Types.ObjectId;
  successorUserId?: Types.ObjectId;
  status: FundStatus;
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

const fundSchema = new Schema<FundDoc>(
  {
    name: { type: String, required: true, trim: true },
    faceValue: paisa({ required: true }),
    policy: { type: fundPolicySchema, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    successorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['ACTIVE', 'CLOSED'], default: 'ACTIVE' },
  },
  baseOpts,
);

fundSchema.index({ 'policy.visibility': 1, status: 1 });
fundSchema.index({ createdBy: 1 });

export const Fund = model<FundDoc>('Fund', fundSchema);
