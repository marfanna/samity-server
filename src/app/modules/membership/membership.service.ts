import { randomBytes } from 'crypto';
import mongoose, { Types } from 'mongoose';
import { Fund } from '../fund/fund.model';
import { Membership } from './membership.model';
import type { Role } from './membership.model';
import { JoinRequest } from './joinRequest.model';
import { Invite } from './invite.model';
import { User } from '../user/user.model';
import { AuditLog } from '../audit/auditLog.model';
import { computeNav } from '../../../shared/nav';
import { notifyUser, notifyFundManagers } from '../../../shared/notify';
import { ApiError } from '../../../utils/ApiError';

const INVITE_BASE = 'https://samity.app/invite';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Public funds available to discover & request to join. Includes the caller's own status per
 * fund (member / pending request) so the UI can show the right action instead of always
 * offering "Request to join" even after one is already in flight.
 */
export async function exploreFunds(userId: string, limit = 50) {
  const funds = await Fund.find({ 'policy.visibility': 'PUBLIC', status: 'ACTIVE' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  const fundIds = funds.map((f) => f._id);

  const [membership, pendingRequests] = await Promise.all([
    Membership.find({ fundId: { $in: fundIds }, userId, status: { $ne: 'EXITED' } }, { fundId: 1 }).lean(),
    JoinRequest.find({ fundId: { $in: fundIds }, userId, status: 'PENDING' }, { fundId: 1 }).lean(),
  ]);
  const memberFundIds = new Set(membership.map((m) => String(m.fundId)));
  const pendingFundIds = new Set(pendingRequests.map((r) => String(r.fundId)));

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
        isMember: memberFundIds.has(String(f._id)),
        requestPending: pendingFundIds.has(String(f._id)),
      };
    }),
  );
}

/** Member roster — names + roles only (privacy split: no amounts). */
export async function getMembers(fundId: string) {
  const memberships = await Membership.find({ fundId, status: { $ne: 'EXITED' } }).lean();
  const users = await User.find(
    { _id: { $in: memberships.map((m) => m.userId) } },
    { name: 1, status: 1 },
  ).lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));
  return memberships.map((m) => {
    const u = userById.get(String(m.userId));
    return {
      membershipId: String(m._id),
      name: u?.name ?? '—',
      role: m.role,
      // imported member who hasn't installed + claimed their account yet
      pendingClaim: u?.status === 'INVITED',
    };
  });
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

  notifyFundManagers(fundId, userId, {
    type: 'JOIN_REQUESTED',
    title: 'New join request',
    body: `${fund.name} has a new request to join.`,
    fundId,
  });

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

    void notifyUser(req.userId, {
      type: 'JOIN_DECLINED',
      title: 'Join request declined',
      body: reason ?? 'Your request to join was declined.',
      fundId,
    });

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

  void notifyUser(req.userId, {
    type: 'JOIN_APPROVED',
    title: 'Join request approved',
    body: 'You can now buy in and join the fund.',
    fundId,
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

/**
 * Change a member's role (admin only). Cannot promote to admin or change the admin.
 * targetMembershipId is the Membership._id (not userId) so the caller is unambiguous.
 */
export async function changeMemberRole(
  actorId: string,
  fundId: string,
  targetMembershipId: string,
  newRole: Role,
) {
  const target = await Membership.findOne({ _id: targetMembershipId, fundId });
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'membership not found');
  if (target.status === 'EXITED') throw new ApiError(409, 'STATE_CONFLICT', 'member has exited the fund');
  if (target.role === 'admin') throw new ApiError(403, 'FORBIDDEN_ROLE', 'cannot change the admin role — use transfer-ownership');
  if (String(target.userId) === actorId) throw new ApiError(403, 'FORBIDDEN_ROLE', 'cannot change your own role');

  const previousRole = target.role;
  if (previousRole === newRole) return { membershipId: targetMembershipId, role: newRole };

  await Membership.updateOne({ _id: targetMembershipId }, { $set: { role: newRole } });

  await AuditLog.create([{
    fundId: new Types.ObjectId(fundId),
    actorId: new Types.ObjectId(actorId),
    action: 'ROLE_CHANGE',
    refType: 'MEMBERSHIP',
    refId: new Types.ObjectId(targetMembershipId),
    before: { role: previousRole },
    after: { role: newRole },
  }]);

  void notifyUser(target.userId, {
    type: 'ROLE_CHANGED',
    title: 'Your role changed',
    body: `You are now a ${newRole} in this fund.`,
    fundId,
  });

  return { membershipId: targetMembershipId, role: newRole };
}

/**
 * Transfer fund ownership (admin only). Old admin → member, target → admin.
 * Target must be an active member of the fund.
 */
export async function transferOwnership(
  actorId: string,
  fundId: string,
  targetMembershipId: string,
) {
  const actorMembership = await Membership.findOne({ fundId, userId: actorId });
  if (!actorMembership || actorMembership.role !== 'admin') {
    throw new ApiError(403, 'FORBIDDEN_ROLE', 'only the admin can transfer ownership');
  }

  const target = await Membership.findOne({ _id: targetMembershipId, fundId });
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'target membership not found');
  if (target.status !== 'ACTIVE') throw new ApiError(409, 'STATE_CONFLICT', 'target member must be ACTIVE');
  if (String(target.userId) === actorId) throw new ApiError(400, 'VALIDATION', 'cannot transfer ownership to yourself');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Membership.updateOne({ _id: actorMembership._id }, { $set: { role: 'member' } }, { session });
      await Membership.updateOne({ _id: targetMembershipId }, { $set: { role: 'admin' } }, { session });

      await AuditLog.create([{
        fundId: new Types.ObjectId(fundId),
        actorId: new Types.ObjectId(actorId),
        action: 'OWNERSHIP_TRANSFER',
        refType: 'MEMBERSHIP',
        refId: new Types.ObjectId(targetMembershipId),
        before: { adminMembershipId: String(actorMembership._id) },
        after: { adminMembershipId: targetMembershipId },
      }], { session });
    });
  } finally {
    await session.endSession();
  }

  void notifyUser(target.userId, {
    type: 'OWNERSHIP_TRANSFERRED',
    title: 'You are now the fund admin',
    body: 'Ownership of the fund has been transferred to you.',
    fundId,
  });

  return { newAdminMembershipId: targetMembershipId };
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
