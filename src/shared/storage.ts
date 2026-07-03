import { promises as fs } from 'fs';
import path from 'path';
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

/** Absolute on-disk path for a storage key (local driver). Guards against path traversal. */
function localPath(key: string): string {
  const base = path.resolve(env.UPLOAD_DIR);
  const full = path.resolve(base, key);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('invalid storage key');
  }
  return full;
}

/**
 * Upload a buffer to storage. Returns the stored key.
 * - STORAGE_ENABLED=false → dev no-op (returns the key, nothing written).
 * - 'local' → writes under UPLOAD_DIR on this server's disk.
 * - 's3'    → puts to the configured bucket.
 */
export async function uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<string> {
  if (!env.STORAGE_ENABLED) {
    // eslint-disable-next-line no-console
    console.warn('[storage] STORAGE_ENABLED=false - upload skipped, key returned as-is');
    return key;
  }

  if (env.STORAGE_DRIVER === 'local') {
    const full = localPath(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    return key;
  }

  await getClient().send(
    new PutObjectCommand({ Bucket: env.STORAGE_BUCKET!, Key: key, Body: buffer, ContentType: contentType }),
  );
  return key;
}

/**
 * A URL the client can use to view a stored object.
 * - 'local' → `${STORAGE_URL_BASE}/${key}` (served by the static mount) or `/files/${key}`.
 * - 's3'    → a presigned GET URL (default 1 hour), or the plain base URL when disabled.
 */
export async function presignedUrl(key: string, expiresIn = 3600): Promise<string> {
  if (env.STORAGE_DRIVER === 'local' || !env.STORAGE_ENABLED) {
    return env.STORAGE_URL_BASE ? `${env.STORAGE_URL_BASE}/${key}` : `/files/${key}`;
  }
  const cmd = new GetObjectCommand({ Bucket: env.STORAGE_BUCKET!, Key: key });
  return getSignedUrl(getClient(), cmd, { expiresIn });
}
