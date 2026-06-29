import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  if (!env.STORAGE_ACCESS_KEY || !env.STORAGE_SECRET_KEY || !env.STORAGE_BUCKET) {
    throw new Error('Storage credentials missing. Set STORAGE_BUCKET, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY.');
  }
  _client = new S3Client({
    region: env.STORAGE_REGION,
    ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
    credentials: {
      accessKeyId: env.STORAGE_ACCESS_KEY,
      secretAccessKey: env.STORAGE_SECRET_KEY,
    },
    // forcePathStyle needed for non-AWS providers (Cloudflare R2, DigitalOcean Spaces, MinIO)
    forcePathStyle: !!env.STORAGE_ENDPOINT,
  });
  return _client;
}

/**
 * Upload a buffer to object storage. Returns the stored key.
 * If STORAGE_ENABLED=false, logs a warning and returns the key unchanged
 * (existing placeholder strings remain valid through the rest of the flow).
 */
export async function uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<string> {
  if (!env.STORAGE_ENABLED) {
    // eslint-disable-next-line no-console
    console.warn('[storage] STORAGE_ENABLED=false - upload skipped, key returned as-is');
    return key;
  }
  await getClient().send(
    new PutObjectCommand({ Bucket: env.STORAGE_BUCKET!, Key: key, Body: buffer, ContentType: contentType }),
  );
  return key;
}

/**
 * Generate a presigned URL for a stored object (default 1 hour).
 * If STORAGE_ENABLED=false and STORAGE_URL_BASE is set, returns a plain URL.
 */
export async function presignedUrl(key: string, expiresIn = 3600): Promise<string> {
  if (!env.STORAGE_ENABLED) {
    return env.STORAGE_URL_BASE ? `${env.STORAGE_URL_BASE}/${key}` : key;
  }
  const cmd = new GetObjectCommand({ Bucket: env.STORAGE_BUCKET!, Key: key });
  return getSignedUrl(getClient(), cmd, { expiresIn });
}
