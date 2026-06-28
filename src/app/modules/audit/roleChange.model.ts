import { Schema, model, Types } from 'mongoose';
import { appendOnlyOpts } from '../../../shared/schemaHelpers';
import type { Role } from '../membership/membership.model';

export type RoleChangeTrigger = 'MANUAL' | 'OWNERSHIP_TRANSFER' | 'SUCCESSION';

export interface RoleChangeDoc {
  _id: Types.ObjectId;
  fundId: Types.ObjectId;
  targetUser: Types.ObjectId;
  oldRole?: Role | null;
  newRole?: Role;
  trigger?: RoleChangeTrigger;
  changedBy?: Types.ObjectId; // null for SUCCESSION (system)
  at: Date; // immutable
}

const roleChangeSchema = new Schema<RoleChangeDoc>(
  {
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund', required: true },
    targetUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    oldRole: { type: String, enum: ['admin', 'moderator', 'member', null] },
    newRole: { type: String, enum: ['admin', 'moderator', 'member'] },
    trigger: { type: String, enum: ['MANUAL', 'OWNERSHIP_TRANSFER', 'SUCCESSION'] },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now, immutable: true },
  },
  appendOnlyOpts,
);

roleChangeSchema.index({ fundId: 1, at: -1 });

export const RoleChange = model<RoleChangeDoc>('RoleChange', roleChangeSchema);
