import { Schema, model, Types } from 'mongoose';
import { baseOpts } from '../../../shared/schemaHelpers';

export type Locale = 'bn' | 'en';
export type UserStatus = 'ACTIVE' | 'DELETED';

export interface UserDoc {
  _id: Types.ObjectId;
  phone: string; // E.164, e.g. +8801…
  name: string;
  passwordHash: string;
  locale: Locale;
  status: UserStatus;
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
    status: { type: String, enum: ['ACTIVE', 'DELETED'], default: 'ACTIVE' },
    lastLoginAt: { type: Date },
  },
  baseOpts,
);

// phone uniqueness comes from the field-level `unique: true` above.

export const User = model<UserDoc>('User', userSchema);
