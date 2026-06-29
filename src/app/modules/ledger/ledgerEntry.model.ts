import { Schema, model, Types } from 'mongoose';
import { signedPaisa, signedInt, intCount, appendOnlyOpts } from '../../../shared/schemaHelpers';

export const LEDGER_KINDS = [
  'CASH_IN',
  'CASH_OUT_INVEST',
  'INVEST_RETURN',
  'DUES_PAID',
  'SHARES_ISSUED',
  'SHARES_TRANSFER',
  'PENALTY',
  'REVERSAL',
  'OPENING_CASH', // imported fund: liquid cash on hand at genesis (counts as NAV cash)
  'OPENING_CONTRIBUTION', // imported fund: per-member cost basis at genesis (display only, not cash)
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export type LedgerRefType = 'DEPOSIT' | 'INVESTMENT' | 'TRANSFER' | 'CORRECTION' | 'POLICY' | 'GENESIS';

export interface LedgerEntryDoc {
  _id: Types.ObjectId;
  fundId: Types.ObjectId;
  kind: LedgerKind;
  amount: number; // signed paisa; sign per kind (0 for pure markers)
  shares: number; // ± for share kinds
  cyclesCovered: number; // for DUES_PAID
  membershipId?: Types.ObjectId;
  fromMembershipId?: Types.ObjectId;
  toMembershipId?: Types.ObjectId;
  refType?: LedgerRefType;
  refId?: Types.ObjectId;
  reversalOf?: Types.ObjectId;
  createdBy: Types.ObjectId;
  at: Date; // immutable event time
}

const ledgerEntrySchema = new Schema<LedgerEntryDoc>(
  {
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund', required: true },
    kind: { type: String, enum: LEDGER_KINDS, required: true },
    amount: signedPaisa({ default: 0 }),
    shares: signedInt({ default: 0 }),
    cyclesCovered: intCount({ default: 0 }),
    membershipId: { type: Schema.Types.ObjectId, ref: 'Membership' },
    fromMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership' },
    toMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership' },
    refType: { type: String, enum: ['DEPOSIT', 'INVESTMENT', 'TRANSFER', 'CORRECTION', 'POLICY', 'GENESIS'] },
    refId: { type: Schema.Types.ObjectId },
    reversalOf: { type: Schema.Types.ObjectId, ref: 'LedgerEntry' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now, immutable: true },
  },
  appendOnlyOpts,
);

// guard against mutation — the ledger is append-only, the source of truth
ledgerEntrySchema.pre('findOneAndUpdate', function () {
  throw new Error('LedgerEntry is append-only');
});
ledgerEntrySchema.pre('updateOne', function () {
  throw new Error('LedgerEntry is append-only');
});
ledgerEntrySchema.pre('updateMany', function () {
  throw new Error('LedgerEntry is append-only');
});

ledgerEntrySchema.index({ fundId: 1, kind: 1 }); // balance aggregation
ledgerEntrySchema.index({ fundId: 1, at: 1 }); // chronological ledger
ledgerEntrySchema.index({ refType: 1, refId: 1 }); // trace to source

export const LedgerEntry = model<LedgerEntryDoc>('LedgerEntry', ledgerEntrySchema);
