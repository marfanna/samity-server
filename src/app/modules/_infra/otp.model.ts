import { Schema, model } from 'mongoose';

/** SMS OTP for phone ownership (register / reset). 5-min TTL on createdAt. */
export interface OtpDoc {
  phone: string;
  purpose: 'REGISTER' | 'RESET';
  codeHash: string;
  attempts: number;
  /** Pending data held until verification (e.g. REGISTER: { name, passwordHash }). */
  payload?: Record<string, unknown>;
  createdAt: Date;
}

const OtpSchema = new Schema<OtpDoc>(
  {
    phone: { type: String, required: true },
    purpose: { type: String, enum: ['REGISTER', 'RESET'], required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0 },
    payload: { type: Schema.Types.Mixed },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false },
);

OtpSchema.index({ phone: 1, purpose: 1 });
OtpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 300 }); // 5 min

export const Otp = model<OtpDoc>('Otp', OtpSchema);
