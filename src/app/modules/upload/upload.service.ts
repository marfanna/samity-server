import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { uploadBuffer, presignedUrl } from '../../../shared/storage';
import { ApiError } from '../../../utils/ApiError';

const MAX_DIMENSION = 1600; // px — screenshots never need more; caps output size
const WEBP_QUALITY = 80;

/**
 * Store an uploaded payment screenshot and return a stable key + a viewable URL.
 * The input may be any image format; it is re-encoded to WebP (smaller), auto-oriented
 * from EXIF, downscaled to fit MAX_DIMENSION, and stripped of metadata (removes GPS etc).
 * The key is what callers persist (e.g. Deposit.screenshotUrl).
 */
export async function uploadScreenshot(
  userId: string,
  file: { buffer: Buffer },
): Promise<{ key: string; url: string }> {
  let webp: Buffer;
  try {
    webp = await sharp(file.buffer)
      .rotate() // apply EXIF orientation, then metadata is dropped below
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'unsupported or corrupt image');
  }

  const key = `screenshots/${userId}/${randomUUID()}.webp`;
  await uploadBuffer(key, webp, 'image/webp');
  const url = await presignedUrl(key);
  return { key, url };
}
