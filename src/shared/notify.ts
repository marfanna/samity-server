import { Types } from 'mongoose';
import { Notification } from '../app/modules/notification/notification.model';
import { User } from '../app/modules/user/user.model';
import { sendPushMulti } from './fcm';

export interface NotifyPayload {
  type: string;
  title: string;
  body: string;
  deepLink?: string;
  fundId?: Types.ObjectId | string;
}

/**
 * Persist a Notification doc and send an FCM push to all the user's registered devices.
 * Best-effort — never throws. Call without await for fire-and-forget.
 */
export async function notifyUser(userId: string | Types.ObjectId, payload: NotifyPayload): Promise<void> {
  try {
    await Notification.create({
      userId: typeof userId === 'string' ? new Types.ObjectId(userId) : userId,
      ...(payload.fundId ? { fundId: typeof payload.fundId === 'string' ? new Types.ObjectId(payload.fundId) : payload.fundId } : {}),
      type: payload.type,
      title: payload.title,
      body: payload.body,
      ...(payload.deepLink ? { deepLink: payload.deepLink } : {}),
      read: false,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[notify] failed to persist notification:', (err as Error).message);
  }

  try {
    const user = await User.findById(userId, { fcmTokens: 1 }).lean();
    if (user?.fcmTokens?.length) {
      await sendPushMulti(user.fcmTokens, {
        title: payload.title,
        body: payload.body,
        ...(payload.deepLink ? { deepLink: payload.deepLink } : {}),
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[notify] FCM send failed:', (err as Error).message);
  }
}

/**
 * Notify all active members of a fund. Uses setImmediate to not block the response.
 */
export function notifyFundMembers(
  fundId: string | Types.ObjectId,
  excludeUserId: string | undefined,
  payload: NotifyPayload,
): void {
  setImmediate(async () => {
    try {
      const { Membership } = await import('../app/modules/membership/membership.model');
      const memberships = await Membership.find(
        { fundId, status: 'ACTIVE' },
        { userId: 1 },
      ).lean();

      await Promise.allSettled(
        memberships
          .filter((m) => !excludeUserId || String(m.userId) !== excludeUserId)
          .map((m) => notifyUser(m.userId, { ...payload, fundId })),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[notify] notifyFundMembers failed:', (err as Error).message);
    }
  });
}

/**
 * Notify a fund's admin + moderators (e.g. "action needed" events). Uses setImmediate
 * to not block the response.
 */
export function notifyFundManagers(
  fundId: string | Types.ObjectId,
  excludeUserId: string | undefined,
  payload: NotifyPayload,
): void {
  setImmediate(async () => {
    try {
      const { Membership } = await import('../app/modules/membership/membership.model');
      const memberships = await Membership.find(
        { fundId, status: 'ACTIVE', role: { $in: ['admin', 'moderator'] } },
        { userId: 1 },
      ).lean();

      await Promise.allSettled(
        memberships
          .filter((m) => !excludeUserId || String(m.userId) !== excludeUserId)
          .map((m) => notifyUser(m.userId, { ...payload, fundId })),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[notify] notifyFundManagers failed:', (err as Error).message);
    }
  });
}
