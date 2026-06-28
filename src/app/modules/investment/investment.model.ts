import { Schema, model, Types } from 'mongoose';
import { paisa, signedPaisa, baseOpts } from '../../../shared/schemaHelpers';

export type InvestmentState = 'PROPOSED' | 'ACTIVE' | 'RETURNED' | 'SETTLED';

export interface InvestmentDoc {
  _id: Types.ObjectId;
  fundId: Types.ObjectId;
  amountCost: number; // money out, at cost (paisa)
  destination: string;
  expectedReturn: number;
  expectedDate?: Date;
  actualReturn: number; // filled on return
  returnScreenshotUrl?: string;
  profitLoss: number; // actualReturn - amountCost (derived, cached)
  state: InvestmentState;
  recordedBy: Types.ObjectId;
  returnedBy?: Types.ObjectId;
  returnedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const investmentSchema = new Schema<InvestmentDoc>(
  {
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund', required: true },
    amountCost: paisa({ required: true }),
    destination: { type: String, required: true },
    expectedReturn: paisa({ default: 0 }),
    expectedDate: { type: Date },
    actualReturn: paisa({ default: 0 }),
    returnScreenshotUrl: { type: String },
    profitLoss: signedPaisa({ default: 0 }),
    state: { type: String, enum: ['PROPOSED', 'ACTIVE', 'RETURNED', 'SETTLED'], default: 'ACTIVE' },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    returnedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    returnedAt: { type: Date },
  },
  baseOpts,
);

investmentSchema.index({ fundId: 1, state: 1 }); // active → investedAtCost

export const Investment = model<InvestmentDoc>('Investment', investmentSchema);
