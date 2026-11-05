import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../audit/auditLog.model';
import { Lock } from '../_infra/lock.model';
import { Fund } from '../fund/fund.model';
import { Investment } from '../investment/investment.model';
import { LedgerEntry } from '../ledger/ledgerEntry.model';
import { Membership } from '../membership/membership.model';
import { NavSnapshot } from '../nav/navSnapshot.model';
import { User } from '../user/user.model';
import { computeNav } from '../../../shared/nav';
import { fundMemberPositions } from '../../../shared/economics';
import { getPortfolioHistory } from '../me/me.service';
import { Deposit } from './deposit.model';
import { rejectDeposit, submitDeposit, verifyDeposit } from './deposit.service';

let replSet: MongoMemoryReplSet;

type Fixture = {
  fundId: Types.ObjectId;
  adminUserId: Types.ObjectId;
  memberUserId: Types.ObjectId;
  adminMembershipId: Types.ObjectId;
  memberMembershipId: Types.ObjectId;
};

async function createFixture(memberStatus: 'PENDING_BUYIN' | 'ACTIVE' = 'PENDING_BUYIN'): Promise<Fixture> {
  const [admin, member] = await User.create([
    { phone: '+8801700001001', name: 'Admin', passwordHash: 'hash' },
    { phone: '+8801700001002', name: 'Member', passwordHash: 'hash' },
  ]);
  const fund = await Fund.create({
    name: 'Deposit Test Fund',
    faceValue: 20000,
    policy: {
      cycleUnit: 'WEEKLY',
      startDate: new Date(),
      visibility: 'INVITE_ONLY',
      shareChange: 'BOTH',
      nonPayment: 'TRACK_ONLY',
      joinLock: 'ALLOW',
    },
    createdBy: admin!._id,
  });
  const [adminMembership, memberMembership] = await Membership.create([
    {
      userId: admin!._id,
      fundId: fund._id,
      role: 'admin',
      status: 'ACTIVE',
      shares: 5,
      joinNav: 20000,
    },
    {
      userId: member!._id,
      fundId: fund._id,
      role: 'member',
      status: memberStatus,
      shares: memberStatus === 'ACTIVE' ? 3 : 0,
      joinNav: 20000,
    },
  ]);
  await LedgerEntry.create([
    { fundId: fund._id, kind: 'CASH_IN', amount: 100000, membershipId: adminMembership!._id, createdBy: admin!._id },
    { fundId: fund._id, kind: 'SHARES_ISSUED', shares: 5, membershipId: adminMembership!._id, createdBy: admin!._id },
    ...(memberStatus === 'ACTIVE'
      ? [
          {
            fundId: fund._id,
            kind: 'CASH_IN',
            amount: 60000,
            membershipId: memberMembership!._id,
            createdBy: admin!._id,
          },
          {
            fundId: fund._id,
            kind: 'SHARES_ISSUED',
            shares: 3,
            membershipId: memberMembership!._id,
            createdBy: admin!._id,
          },
        ]
      : []),
  ]);

  return {
    fundId: fund._id,
    adminUserId: admin!._id,
    memberUserId: member!._id,
    adminMembershipId: adminMembership!._id,
    memberMembershipId: memberMembership!._id,
  };
}

describe('deposit service', () => {
  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri(), { dbName: 'samity_phase09' });
  }, 120_000);

  beforeEach(async () => {
    await Promise.all([
      AuditLog.deleteMany({}),
      Deposit.deleteMany({}),
      Fund.deleteMany({}),
      Investment.deleteMany({}),
      LedgerEntry.deleteMany({}),
      Lock.deleteMany({}),
      Membership.deleteMany({}),
      NavSnapshot.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  it('submits and verifies a buy-in deposit under ledger/NAV/audit rules', async () => {
    const fixture = await createFixture();
    const submitted = await submitDeposit(String(fixture.memberUserId), String(fixture.fundId), String(fixture.memberMembershipId), {
      type: 'BUY_IN',
      amount: 60000,
      cyclesCovered: 0,
      sharesRequested: 3,
      screenshotUrl: 'proof/deposit-1.png',
    });

    expect(submitted.status).toBe('PENDING');
    expect(submitted.navAtSubmit).toBe(20000);

    const verified = await verifyDeposit(String(fixture.adminUserId), String(fixture.fundId), submitted.depositId);

    expect(verified).toMatchObject({
      status: 'VERIFIED',
      sharesIssued: 3,
      navAtVerify: 20000,
      nav: 20000,
    });

    await expect(computeNav(fixture.fundId)).resolves.toMatchObject({
      nav: 20000,
      totalShares: 8,
      cash: 160000,
      totalAssets: 160000,
    });

    await expect(Membership.findById(fixture.memberMembershipId).lean()).resolves.toMatchObject({
      status: 'ACTIVE',
      shares: 3,
      joinNav: 20000,
    });
    await expect(LedgerEntry.find({ refType: 'DEPOSIT', refId: new Types.ObjectId(submitted.depositId) }).lean()).resolves.toHaveLength(2);
    await expect(NavSnapshot.countDocuments({ fundId: fixture.fundId, reason: 'DEPOSIT' })).resolves.toBe(1);
    await expect(AuditLog.countDocuments({ fundId: fixture.fundId, action: 'DEPOSIT_VERIFY' })).resolves.toBe(1);
  });

  it('blocks self-deal verification', async () => {
    const fixture = await createFixture();
    const submitted = await submitDeposit(String(fixture.memberUserId), String(fixture.fundId), String(fixture.memberMembershipId), {
      type: 'BUY_IN',
      amount: 60000,
      cyclesCovered: 0,
      sharesRequested: 3,
      screenshotUrl: 'proof/deposit-1.png',
    });

    await expect(verifyDeposit(String(fixture.memberUserId), String(fixture.fundId), submitted.depositId)).rejects.toMatchObject({
      code: 'SELF_DEAL_BLOCKED',
      statusCode: 403,
    });
  });

  it('submits and verifies a regular deposit, credits cycles, and recomputes NAV', async () => {
    const fixture = await createFixture('ACTIVE');
    const submitted = await submitDeposit(String(fixture.memberUserId), String(fixture.fundId), String(fixture.memberMembershipId), {
      type: 'REGULAR',
      amount: 60000,
      cyclesCovered: 1,
      sharesRequested: 0,
      screenshotUrl: 'proof/regular-1.png',
    });

    const verified = await verifyDeposit(String(fixture.adminUserId), String(fixture.fundId), submitted.depositId);

    expect(verified).toMatchObject({ status: 'VERIFIED', sharesIssued: 0, navAtVerify: 0, nav: 20000 });
    await expect(Membership.findById(fixture.memberMembershipId).lean()).resolves.toMatchObject({
      paidThroughCycle: 1,
    });
    await expect(LedgerEntry.find({ refType: 'DEPOSIT', refId: new Types.ObjectId(submitted.depositId) }).lean()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'CASH_IN', amount: 60000 }),
        expect.objectContaining({ kind: 'DUES_PAID', cyclesCovered: 1 }),
      ]),
    );
  });

  it('rejects a pending deposit with an audit entry and no ledger mutation', async () => {
    const fixture = await createFixture();
    const submitted = await submitDeposit(String(fixture.memberUserId), String(fixture.fundId), String(fixture.memberMembershipId), {
      type: 'BUY_IN',
      amount: 60000,
      cyclesCovered: 0,
      sharesRequested: 3,
      screenshotUrl: 'proof/deposit-1.png',
    });

    await expect(
      rejectDeposit(String(fixture.adminUserId), String(fixture.fundId), submitted.depositId, {
        reason: 'Screenshot amount does not match bank.',
      }),
    ).resolves.toEqual({ depositId: submitted.depositId, status: 'REJECTED' });

    await expect(Deposit.findById(submitted.depositId).lean()).resolves.toMatchObject({
      status: 'REJECTED',
      reason: 'Screenshot amount does not match bank.',
    });
    await expect(LedgerEntry.countDocuments({ refType: 'DEPOSIT', refId: new Types.ObjectId(submitted.depositId) })).resolves.toBe(0);
    await expect(AuditLog.countDocuments({ action: 'DEPOSIT_REJECT' })).resolves.toBe(1);
  });

  it('rejects malformed deposit amounts before creating a pending deposit', async () => {
    const fixture = await createFixture('ACTIVE');

    await expect(
      submitDeposit(String(fixture.memberUserId), String(fixture.fundId), String(fixture.memberMembershipId), {
        type: 'REGULAR',
        amount: 1,
        cyclesCovered: 1,
        sharesRequested: 0,
        screenshotUrl: 'proof/bad.png',
      }),
    ).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });
    await expect(Deposit.countDocuments({ fundId: fixture.fundId })).resolves.toBe(0);
  });

  it('blocks active-member buy-more deposits when the fund policy is fixed shares', async () => {
    const fixture = await createFixture('ACTIVE');
    await Fund.updateOne({ _id: fixture.fundId }, { $set: { 'policy.shareChange': 'FIXED' } });

    await expect(
      submitDeposit(String(fixture.memberUserId), String(fixture.fundId), String(fixture.memberMembershipId), {
        type: 'BUY_IN',
        amount: 60000,
        cyclesCovered: 0,
        sharesRequested: 3,
        screenshotUrl: 'proof/buy-more.png',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_ROLE' });
  });

  it('prices a mid-fund buy-in without diluting NAV or existing members, and starts the buyer fully paid', async () => {
    const fixture = await createFixture();
    const DAY = 24 * 60 * 60 * 1000;
    await Fund.updateOne({ _id: fixture.fundId }, { $set: { 'policy.startDate': new Date(Date.now() - 21 * DAY - 60_000) } });
    // Realized ৳400 profit on a ৳500 investment — admin (5 shares) earned it all.
    const [inv] = await Investment.create([
      { fundId: fixture.fundId, amountCost: 50000, destination: 'x', state: 'RETURNED', actualReturn: 90000, profitLoss: 40000, recordedBy: fixture.adminUserId },
    ]);
    await LedgerEntry.create([
      { fundId: fixture.fundId, kind: 'CASH_OUT_INVEST', amount: -50000, refType: 'INVESTMENT', refId: inv!._id, createdBy: fixture.adminUserId },
      { fundId: fixture.fundId, kind: 'INVEST_RETURN', amount: 90000, refType: 'INVESTMENT', refId: inv!._id, createdBy: fixture.adminUserId },
    ]);

    const before = await computeNav(fixture.fundId);
    expect(before).toMatchObject({ nav: 68000, principalPerShare: 60000, profitPerShare: 8000, totalAssets: 140000 });
    const adminBefore = (await fundMemberPositions(fixture.fundId, before.totalAssets)).get(String(fixture.adminMembershipId));
    expect(adminBefore).toMatchObject({ contributed: 100000, value: 140000, profitShare: 40000 });

    const submitted = await submitDeposit(String(fixture.memberUserId), String(fixture.fundId), String(fixture.memberMembershipId), {
      type: 'BUY_IN',
      amount: 3 * 68000,
      cyclesCovered: 0,
      sharesRequested: 3,
      screenshotUrl: 'proof/mid-fund.png',
    });
    await verifyDeposit(String(fixture.adminUserId), String(fixture.fundId), submitted.depositId);

    const after = await computeNav(fixture.fundId);
    expect(after).toMatchObject({ nav: 68000, totalShares: 8, totalAssets: 344000 });

    const premium = await LedgerEntry.findOne({ kind: 'BUYIN_PREMIUM', refId: new Types.ObjectId(submitted.depositId) }).lean();
    expect(premium).toMatchObject({ amount: 24000 });

    const positions = await fundMemberPositions(fixture.fundId, after.totalAssets);
    expect(positions.get(String(fixture.adminMembershipId))).toMatchObject({ value: 140000, profitShare: 40000 });
    expect(positions.get(String(fixture.memberMembershipId))).toMatchObject({ contributed: 204000, value: 204000, profitShare: 0 });

    await expect(Membership.findById(fixture.memberMembershipId).lean()).resolves.toMatchObject({
      status: 'ACTIVE',
      shares: 3,
      joinCycle: 3,
      paidThroughCycle: 3,
    });
    // Trend chart replays the same buy-in-aware value — no inflated point for the buyer.
    const history = await getPortfolioHistory(String(fixture.memberUserId));
    expect(history.at(-1)?.value).toBe(204000);
    expect(Math.max(...history.map((p) => p.value))).toBe(204000);
  });

  it('shares profit earned after a buy-in with the buyer by money paid', async () => {
    const fixture = await createFixture();
    const DAY = 24 * 60 * 60 * 1000;
    await Fund.updateOne({ _id: fixture.fundId }, { $set: { 'policy.startDate': new Date(Date.now() - 21 * DAY - 60_000) } });
    const submitted = await submitDeposit(String(fixture.memberUserId), String(fixture.fundId), String(fixture.memberMembershipId), {
      type: 'BUY_IN',
      amount: 3 * 60000,
      cyclesCovered: 0,
      sharesRequested: 3,
      screenshotUrl: 'proof/no-profit-yet.png',
    });
    await verifyDeposit(String(fixture.adminUserId), String(fixture.fundId), submitted.depositId);
    // No premium at zero profit.
    await expect(LedgerEntry.countDocuments({ kind: 'BUYIN_PREMIUM' })).resolves.toBe(0);

    // Later ৳560 profit: admin paid 100000, member 180000 → 5:9 split.
    const [inv] = await Investment.create([
      { fundId: fixture.fundId, amountCost: 50000, destination: 'x', state: 'RETURNED', actualReturn: 106000, profitLoss: 56000, recordedBy: fixture.adminUserId },
    ]);
    await LedgerEntry.create([
      { fundId: fixture.fundId, kind: 'CASH_OUT_INVEST', amount: -50000, refType: 'INVESTMENT', refId: inv!._id, createdBy: fixture.adminUserId },
      { fundId: fixture.fundId, kind: 'INVEST_RETURN', amount: 106000, refType: 'INVESTMENT', refId: inv!._id, createdBy: fixture.adminUserId },
    ]);
    const nav = await computeNav(fixture.fundId);
    const positions = await fundMemberPositions(fixture.fundId, nav.totalAssets);
    expect(positions.get(String(fixture.adminMembershipId))).toMatchObject({ profitShare: 20000 });
    expect(positions.get(String(fixture.memberMembershipId))).toMatchObject({ profitShare: 36000 });
  });
});
