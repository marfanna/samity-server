import { Schema, model, Types } from 'mongoose';
import { paisa, signedPaisa, intCount, appendOnlyOpts } from '../../../shared/schemaHelpers';

export type NavReason = 'DEPOSIT' | 'INVEST' | 'INVEST_RETURN' | 'TRANSFER' | 'CORRECTION' | 'INIT';

export interface NavSnapshotDoc {
  _id: Types.ObjectId;
  fundId: Types.ObjectId;
  nav: number; // paisa per share
  totalShares: number;
  totalAssets: number; // cash + investedAtCost
  cash: number;
  investedAtCost: number;
  reason?: NavReason;
  meta?: Record<string, unknown>; // e.g. { profitLoss }
  at: Date; // immutable
}

const navSnapshotSchema = new Schema<NavSnapshotDoc>(
  {
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund', required: true },
    nav: paisa({ required: true }),
    totalShares: intCount({ required: true }),
    totalAssets: paisa({ required: true }),
    cash: signedPaisa({ default: 0 }),
    investedAtCost: paisa({ default: 0 }),
    reason: { type: String, enum: ['DEPOSIT', 'INVEST', 'INVEST_RETURN', 'TRANSFER', 'CORRECTION', 'INIT'] },
    meta: { type: Schema.Types.Mixed },
    at: { type: Date, default: Date.now, immutable: true },
  },
  appendOnlyOpts,
);

navSnapshotSchema.pre('findOneAndUpdate', function () {
  throw new Error('NavSnapshot is append-only');
});

navSnapshotSchema.index({ fundId: 1, at: 1 }); // history + latest (at: -1)

export const NavSnapshot = model<NavSnapshotDoc>('NavSnapshot', navSnapshotSchema);
