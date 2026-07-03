import { Types } from 'mongoose';
import { Notification } from './notification.model';

/** List user's notifications — unread first, then by time desc. Max 50. */
export async function listNotifications(userId: string) {
  const docs = await Notification.find({ userId: new Types.ObjectId(userId) })
    .sort({ read: 1, at: -1 })
    .limit(50)
    .lean();

  return docs.map((n) => ({
    id: String(n._id),
    type: n.type,
    title: n.title,
    body: n.body,
    deepLink: n.deepLink,
    fundId: n.fundId ? String(n.fundId) : undefined,
    read: n.read,
    at: n.at.toISOString(),
  }));
}

/** Mark all unread notifications as read for a user. */
export async function markAllRead(userId: string) {
  const result = await Notification.updateMany(
    { userId: new Types.ObjectId(userId), read: false },
    { $set: { read: true } },
  );
  return { updated: result.modifiedCount };
}

/** Mark specific notification IDs as read (caller must own them). */
export async function markRead(userId: string, ids: string[]) {
  const result = await Notification.updateMany(
    { _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, userId: new Types.ObjectId(userId) },
    { $set: { read: true } },
  );
  return { updated: result.modifiedCount };
}
