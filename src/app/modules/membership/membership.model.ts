import { Schema, model, Types } from 'mongoose';
import { paisa, intCount, baseOpts } from '../../../shared/schemaHelpers';

export type Role = 'admin' | 'moderator' | 'member';
export type MembershipStatus = 'PENDING_BUYIN' | 'ACTIVE' | 'SUSPENDED' | 'EXITED';

export interface MembershipDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  fundId: Types.ObjectId;
  shares: number; // denormalised; reconstructable from ledger
  role: Role;
  joinNav: number; // paisa, NAV at issuance
  joinCycle: number;
  paidThroughCycle: number; // dues cursor
  status: MembershipStatus;
  missedCycles: number;
  createdAt: Date;
  updatedAt: Date;
}

const membershipSchema = new Schema<MembershipDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund', required: true },
    shares: intCount({ default: 0 }),
    role: { type: String, enum: ['admin', 'moderator', 'member'], default: 'member' },
    joinNav: paisa({ default: 0 }),
    joinCycle: intCount({ default: 0 }),
    paidThroughCycle: intCount({ default: 0 }),
    status: {
      type: String,
      enum: ['PENDING_BUYIN', 'ACTIVE', 'SUSPENDED', 'EXITED'],
      default: 'PENDING_BUYIN',
    },
    missedCycles: intCount({ default: 0 }),
  },
  baseOpts,
);

membershipSchema.index({ fundId: 1, userId: 1 }, { unique: true }); // one per (user,fund)
membershipSchema.index({ userId: 1, status: 1 }); // dashboard
membershipSchema.index({ fundId: 1, status: 1 }); // member list / totalShares
membershipSchema.index({ fundId: 1, role: 1 }); // find admin/mods

export const Membership = model<MembershipDoc>('Membership', membershipSchema);
