import { Schema, model, Types } from 'mongoose';
import { baseOpts } from '../../../shared/schemaHelpers';

export type JoinRequestStatus = 'PENDING' | 'APPROVED' | 'DECLINED';

export interface JoinRequestDoc {
  _id: Types.ObjectId;
  fundId: Types.ObjectId;
  userId: Types.ObjectId;
  status: JoinRequestStatus;
  decidedBy?: Types.ObjectId;
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const joinRequestSchema = new Schema<JoinRequestDoc>(
  {
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'DECLINED'], default: 'PENDING' },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String },
  },
  baseOpts,
);

joinRequestSchema.index({ fundId: 1, status: 1 });
joinRequestSchema.index({ fundId: 1, userId: 1 });

export const JoinRequest = model<JoinRequestDoc>('JoinRequest', joinRequestSchema);
