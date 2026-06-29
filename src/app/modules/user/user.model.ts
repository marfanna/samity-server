import { Schema, model, Types } from 'mongoose';
import { baseOpts } from '../../../shared/schemaHelpers';

export type Locale = 'bn' | 'en';
// INVITED = placeholder created by an imported fund's roster; upgraded to ACTIVE when the
// real person registers with that phone (claim). Cannot log in (sentinel passwordHash).
export type UserStatus = 'ACTIVE' | 'DELETED' | 'INVITED';

export interface UserDoc {
  _id: Types.ObjectId;
  phone: string; // E.164, e.g. +8801…
  name: string;
  passwordHash: string;
  locale: Locale;
  status: UserStatus;
  fcmTokens: string[]; // device FCM registration tokens (multiple devices)
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    phone: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    locale: { type: String, enum: ['bn', 'en'], default: 'bn' },
    status: { type: String, enum: ['ACTIVE', 'DELETED', 'INVITED'], default: 'ACTIVE' },
    fcmTokens: { type: [String], default: [] },
    lastLoginAt: { type: Date },
  },
  baseOpts,
);

// phone uniqueness comes from the field-level `unique: true` above.

export const User = model<UserDoc>('User', userSchema);
