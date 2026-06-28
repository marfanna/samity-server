import { Schema, model, Types } from 'mongoose';
import { paisa, intCount, baseOpts } from '../../../shared/schemaHelpers';

export type ShareTransferState = 'INITIATED' | 'BOTH_CONFIRMED' | 'APPROVED' | 'CANCELLED' | 'EXPIRED';

export interface ShareTransferDoc {
  _id: Types.ObjectId;
  fundId: Types.ObjectId;
  fromMembershipId: Types.ObjectId;
  // buyer may not have a membership yet (new joiner) — capture both forms:
  toMembershipId?: Types.ObjectId;
  toUserId?: Types.ObjectId;
  toPhone?: string;
  shares: number;
  navAtTransfer: number; // reference price (paisa)
  agreedAmount: number; // what buyer actually paid seller
  screenshotUrl?: string;
  sellerConfirmed: boolean;
  buyerConfirmed: boolean;
  state: ShareTransferState;
  approvedBy?: Types.ObjectId;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const shareTransferSchema = new Schema<ShareTransferDoc>(
  {
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund', required: true },
    fromMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    toMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership' },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    toPhone: { type: String },
    shares: intCount({ required: true, min: 1 }),
    navAtTransfer: paisa({ default: 0 }),
    agreedAmount: paisa({ required: true }),
    screenshotUrl: { type: String },
    sellerConfirmed: { type: Boolean, default: false },
    buyerConfirmed: { type: Boolean, default: false },
    state: {
      type: String,
      enum: ['INITIATED', 'BOTH_CONFIRMED', 'APPROVED', 'CANCELLED', 'EXPIRED'],
      default: 'INITIATED',
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    expiresAt: { type: Date }, // sweeper cancels stale INITIATED
  },
  baseOpts,
);

shareTransferSchema.index({ fundId: 1, state: 1 }); // pending approvals
shareTransferSchema.index({ fromMembershipId: 1 });
shareTransferSchema.index({ toMembershipId: 1 });

export const ShareTransfer = model<ShareTransferDoc>('ShareTransfer', shareTransferSchema);
