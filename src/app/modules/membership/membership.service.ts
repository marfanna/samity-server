import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import { Fund } from '../fund/fund.model';
import { Membership } from './membership.model';
import { JoinRequest } from './joinRequest.model';
import { Invite } from './invite.model';
import { User } from '../user/user.model';
import { AuditLog } from '../audit/auditLog.model';
import { computeNav } from '../../../shared/nav';
import { ApiError } from '../../../utils/ApiError';

const INVITE_BASE = 'https://samity.app/invite';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Public funds available to discover & request to join. */
export async function exploreFunds(limit = 50) {
  const funds = await Fund.find({ 'policy.visibility': 'PUBLIC', status: 'ACTIVE' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return Promise.all(
    funds.map(async (f) => {
      const [memberCount, nav] = await Promise.all([
        Membership.countDocuments({ fundId: f._id, status: { $ne: 'EXITED' } }),
        computeNav(f._id),
      ]);
      return {
        fundId: String(f._id),
        name: f.name,
        cycleUnit: f.policy.cycleUnit,
        faceValue: f.faceValue,
        nav: nav.nav,
        memberCount,
      };
    }),
  );
}

/** Member roster — names + roles only (privacy split: no amounts). */
export async function getMembers(fundId: string) {
  const memberships = await Membership.find({ fundId, status: { $ne: 'EXITED' } }).lean();
  const users = await User.find({ _id: { $in: memberships.map((m) => m.userId) } }, { name: 1 }).lean();
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));
  return memberships.map((m) => ({
    membershipId: String(m._id),
    name: nameById.get(String(m.userId)) ?? '—',
    role: m.role,
  }));
}

/** Request to join a PUBLIC fund. INVITE_ONLY funds require an invite instead. */
export async function requestJoin(userId: string, fundId: string) {
  const fund = await Fund.findById(fundId).lean();
  if (!fund || fund.status !== 'ACTIVE') throw new ApiError(404, 'NOT_FOUND', 'fund not found');
  if (fund.policy.visibility !== 'PUBLIC') {
    throw new ApiError(403, 'FORBIDDEN_ROLE', 'this fund is invite-only');
  }

  const existingMembership = await Membership.findOne({ fundId, userId }).lean();
  if (existingMembership) throw new ApiError(409, 'STATE_CONFLICT', 'already a member');

  const existingReq = await JoinRequest.findOne({ fundId, userId, status: 'PENDING' }).lean();
  if (existingReq) throw new ApiError(409, 'STATE_CONFLICT', 'request already pending');

  const req = await JoinRequest.create({ fundId, userId, status: 'PENDING' });
  return { requestId: String(req._id), status: req.status };
}

export async function listJoinRequests(fundId: string, status?: string) {
  const filter: Record<string, unknown> = { fundId };
  if (status) filter.status = status;
  const reqs = await JoinRequest.find(filter).sort({ createdAt: -1 }).lean();
  const users = await User.find({ _id: { $in: reqs.map((r) => r.userId) } }, { name: 1, phone: 1 }).lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return reqs.map((r) => {
    const u = byId.get(String(r.userId));
    return {
      requestId: String(r._id),
      userId: String(r.userId),
      name: u?.name ?? '—',
      phone: u?.phone ?? '',
      status: r.status,
      createdAt: r.createdAt,
    };
  });
}

/** Approve → create a PENDING_BUYIN membership; or decline with a reason. admin/mod. */
export async function decideJoinRequest(
  actorId: string,
  fundId: string,
  requestId: string,
  decision: 'APPROVE' | 'DECLINE',
  reason?: string,
) {
  const req = await JoinRequest.findOne({ _id: requestId, fundId });
  if (!req) throw new ApiError(404, 'NOT_FOUND', 'join request not found');
  if (req.status !== 'PENDING') throw new ApiError(409, 'STATE_CONFLICT', 'request already decided');

  if (decision === 'DECLINE') {
    req.status = 'DECLINED';
    req.decidedBy = new Types.ObjectId(actorId);
    if (reason) req.reason = reason;
    await req.save();
    return { requestId, status: req.status };
  }

  // APPROVE — idempotent against an existing membership
  let membership = await Membership.findOne({ fundId, userId: req.userId });
  if (!membership) {
    const fund = await Fund.findById(fundId).lean();
    membership = await Membership.create({
      userId: req.userId,
      fundId,
      role: 'member',
      status: 'PENDING_BUYIN',
      joinNav: fund?.faceValue ?? 0,
    });
  }
  req.status = 'APPROVED';
  req.decidedBy = new Types.ObjectId(actorId);
  await req.save();

  await AuditLog.create({
    fundId: new Types.ObjectId(fundId),
    actorId: new Types.ObjectId(actorId),
    action: 'JOIN_APPROVE',
    refType: 'JOIN_REQUEST',
    refId: req._id,
    after: { userId: String(req.userId), membershipId: String(membership._id) },
  });

  return { requestId, status: req.status, membershipId: String(membership._id) };
}

/** Generate an invite deep-link for a phone. admin/mod. */
export async function createInvite(actorId: string, fundId: string, phone: string) {
  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const invite = await Invite.create({
    fundId,
    phone,
    token,
    invitedBy: new Types.ObjectId(actorId),
    status: 'PENDING',
    expiresAt,
  });
  return {
    inviteId: String(invite._id),
    token,
    link: `${INVITE_BASE}/${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Accept an invite → creates a PENDING_BUYIN membership for the caller. */
export async function acceptInvite(userId: string, token: string) {
  const invite = await Invite.findOne({ token });
  if (!invite) throw new ApiError(404, 'NOT_FOUND', 'invite not found');
  if (invite.status !== 'PENDING' || invite.expiresAt.getTime() < Date.now()) {
    if (invite.status === 'PENDING') {
      invite.status = 'EXPIRED';
      await invite.save();
    }
    throw new ApiError(409, 'STATE_CONFLICT', 'invite is no longer valid');
  }

  // An invite is issued to a specific phone — only that person may accept it,
  // so a leaked/forwarded token can't let the wrong user into the fund.
  const caller = await User.findById(userId, { phone: 1 }).lean();
  if (!caller || caller.phone !== invite.phone) {
    throw new ApiError(403, 'FORBIDDEN_ROLE', 'this invite was issued to a different phone number');
  }

  const fund = await Fund.findById(invite.fundId).lean();
  if (!fund || fund.status !== 'ACTIVE') throw new ApiError(404, 'NOT_FOUND', 'fund not found');

  let membership = await Membership.findOne({ fundId: invite.fundId, userId });
  if (!membership) {
    membership = await Membership.create({
      userId,
      fundId: invite.fundId,
      role: 'member',
      status: 'PENDING_BUYIN',
      joinNav: fund.faceValue,
    });
  }

  invite.status = 'ACCEPTED';
  await invite.save();

  const nav = await computeNav(invite.fundId);
  return {
    fundId: String(invite.fundId),
    membershipId: String(membership._id),
    status: membership.status,
    nav: nav.nav,
  };
}
