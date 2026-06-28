import { Schema, model, Types } from 'mongoose';
import { appendOnlyOpts } from '../../../shared/schemaHelpers';

export interface AuditLogDoc {
  _id: Types.ObjectId;
  fundId?: Types.ObjectId; // null for platform-level actions
  actorId: Types.ObjectId;
  action: string; // e.g. 'DEPOSIT_VERIFY', 'INVEST_RETURN'
  refType?: string;
  refId?: Types.ObjectId;
  before?: unknown;
  after?: unknown;
  at: Date; // immutable
}

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund' },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true },
    refType: { type: String },
    refId: { type: Schema.Types.ObjectId },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    at: { type: Date, default: Date.now, immutable: true },
  },
  appendOnlyOpts,
);

auditLogSchema.pre('findOneAndUpdate', function () {
  throw new Error('AuditLog is append-only');
});

auditLogSchema.index({ fundId: 1, at: -1 });

export const AuditLog = model<AuditLogDoc>('AuditLog', auditLogSchema);
