import { Schema, model, Types } from 'mongoose';

/** Refresh-token rotation family. TTL on expiresAt. */
export interface RefreshTokenDoc {
  userId: Types.ObjectId;
  tokenHash: string;
  family: string;
  expiresAt: Date;
}

const RefreshTokenSchema = new Schema<RefreshTokenDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

RefreshTokenSchema.index({ userId: 1 });
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = model<RefreshTokenDoc>('RefreshToken', RefreshTokenSchema);
