import { Schema, model, Types } from 'mongoose';
import { paisa, intCount, baseOpts } from '../../../shared/schemaHelpers';

export type DepositType = 'BUY_IN' | 'REGULAR' | 'ADVANCE';
export type DepositStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface DepositDoc {
  _id: Types.ObjectId;
  fundId: Types.ObjectId;
  membershipId: Types.ObjectId;
  type: DepositType;
  amount: number; // total paid (paisa)
  cyclesCovered: number; // 0 for BUY_IN; N for ADVANCE
  sharesRequested: number; // BUY_IN only
  screenshotUrl: string; // private object-storage key
  navAtSubmit: number;
  navAtVerify: number;
  sharesIssued: number;
  status: DepositStatus;
  verifiedBy?: Types.ObjectId;
  rejectedBy?: Types.ObjectId;
  reason?: string;
  note?: string;
  decidedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const depositSchema = new Schema<DepositDoc>(
  {
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund', required: true },
    membershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    type: { type: String, enum: ['BUY_IN', 'REGULAR', 'ADVANCE'], required: true },
    amount: paisa({ required: true }),
    cyclesCovered: intCount({ default: 0 }),
    sharesRequested: intCount({ default: 0 }),
    screenshotUrl: { type: String, required: true },
    navAtSubmit: paisa({ default: 0 }),
    navAtVerify: paisa({ default: 0 }),
    sharesIssued: intCount({ default: 0 }),
    status: { type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED'], default: 'PENDING' },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String },
    note: { type: String },
    decidedAt: { type: Date },
  },
  baseOpts,
);

depositSchema.index({ fundId: 1, status: 1, createdAt: 1 }); // verification queue
depositSchema.index({ membershipId: 1, createdAt: -1 }); // member history

export const Deposit = model<DepositDoc>('Deposit', depositSchema);
