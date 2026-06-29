import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';
import { env } from '../config/env';

let _initialized = false;

function initApp(): boolean {
  if (_initialized) return true;
  if (!env.FCM_SERVICE_ACCOUNT_JSON) {
    // eslint-disable-next-line no-console
    console.warn('[fcm] FCM_SERVICE_ACCOUNT_JSON not set - push notifications disabled');
    return false;
  }
  try {
    const sa = JSON.parse(Buffer.from(env.FCM_SERVICE_ACCOUNT_JSON, 'base64').toString('utf-8')) as Record<string, string>;
    const projectId = sa['project_id'];
    initializeApp({ credential: cert(sa), ...(projectId ? { projectId } : {}) });
    _initialized = true;
    // eslint-disable-next-line no-console
    console.log(`[fcm] Firebase Admin initialized (project: ${sa['project_id']})`);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[fcm] Failed to initialize Firebase Admin:', (err as Error).message);
    return false;
  }
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  deepLink?: string;
}

/**
 * Send a push notification to a single FCM device token.
 * Best-effort - never throws. Returns true if delivered.
 */
export async function sendPush(token: string, payload: PushPayload): Promise<boolean> {
  if (!initApp()) return false;
  try {
    await getMessaging().send({
      token,
      notification: { title: payload.title, body: payload.body },
      ...(payload.data || payload.deepLink
        ? { data: { ...payload.data, ...(payload.deepLink ? { deepLink: payload.deepLink } : {}) } }
        : {}),
      android: { priority: 'high', notification: { channelId: 'samity_default' } },
      apns: { payload: { aps: { badge: 1, sound: 'default' } } },
    });
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[fcm] push failed:', (err as Error).message);
    return false;
  }
}

/**
 * Send to multiple tokens in one batch (up to 500). Returns success count.
 */
export async function sendPushMulti(tokens: string[], payload: PushPayload): Promise<number> {
  if (!initApp() || tokens.length === 0) return 0;
  const message: MulticastMessage = {
    tokens,
    notification: { title: payload.title, body: payload.body },
    android: { priority: 'high', notification: { channelId: 'samity_default' } },
    apns: { payload: { aps: { badge: 1, sound: 'default' } } },
  };
  try {
    const res = await getMessaging().sendEachForMulticast(message);
    return res.successCount;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[fcm] multicast failed:', (err as Error).message);
    return 0;
  }
}
