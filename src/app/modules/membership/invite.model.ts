import { Schema, model, Types } from 'mongoose';
import { baseOpts } from '../../../shared/schemaHelpers';

export type InviteStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED';

export interface InviteDoc {
  _id: Types.ObjectId;
  fundId: Types.ObjectId;
  phone: string;
  token: string; // random, in deep-link
  invitedBy: Types.ObjectId;
  status: InviteStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const inviteSchema = new Schema<InviteDoc>(
  {
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund', required: true },
    phone: { type: String, required: true },
    token: { type: String, required: true, unique: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['PENDING', 'ACCEPTED', 'EXPIRED'], default: 'PENDING' },
    expiresAt: { type: Date, required: true },
  },
  baseOpts,
);

// token uniqueness comes from the field-level `unique: true` above.
inviteSchema.index({ phone: 1, fundId: 1 });

export const Invite = model<InviteDoc>('Invite', inviteSchema);
