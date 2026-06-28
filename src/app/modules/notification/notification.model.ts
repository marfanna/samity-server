import { Schema, model, Types } from 'mongoose';
import { appendOnlyOpts } from '../../../shared/schemaHelpers';

export interface NotificationDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  fundId?: Types.ObjectId; // optional context
  type: string; // 'DEPOSIT_VERIFIED', 'DUES_BEHIND', …
  title: string;
  body: string;
  deepLink?: string;
  read: boolean;
  at: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund' },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    deepLink: { type: String },
    read: { type: Boolean, default: false },
    at: { type: Date, default: Date.now },
  },
  appendOnlyOpts,
);

notificationSchema.index({ userId: 1, read: 1, at: -1 });

export const Notification = model<NotificationDoc>('Notification', notificationSchema);
