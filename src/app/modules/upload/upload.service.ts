import { randomUUID } from 'crypto';
import { uploadBuffer, presignedUrl } from '../../../shared/storage';
import { ApiError } from '../../../utils/ApiError';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/**
 * Store an uploaded payment screenshot and return a stable key + a viewable URL.
 * The key is what callers persist (e.g. Deposit.screenshotUrl); the URL is for display.
 * With STORAGE_ENABLED=false the storage layer returns the key unchanged (dev no-op).
 */
export async function uploadScreenshot(
  userId: string,
  file: { buffer: Buffer; mimetype: string },
): Promise<{ key: string; url: string }> {
  const ext = EXT_BY_MIME[file.mimetype];
  if (!ext) throw new ApiError(400, 'VALIDATION_ERROR', 'unsupported image type');

  const key = `screenshots/${userId}/${randomUUID()}.${ext}`;
  await uploadBuffer(key, file.buffer, file.mimetype);
  const url = await presignedUrl(key);
  return { key, url };
}
