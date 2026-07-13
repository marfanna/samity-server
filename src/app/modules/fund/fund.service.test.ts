import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../audit/auditLog.model';
import { Lock } from '../_infra/lock.model';
import { Deposit } from '../deposit/deposit.model';
import { Investment } from '../investment/investment.model';
import { LedgerEntry } from '../ledger/ledgerEntry.model';
import { Membership } from '../membership/membership.model';
import { NavSnapshot } from '../nav/navSnapshot.model';
import { User } from '../user/user.model';
import { computeNav } from '../../../shared/nav';
import { Fund } from './fund.model';
import { createFund, importFund } from './fund.service';
import type { CreateFundInput, ImportFundInput } from './fund.validation';

let replSet: MongoMemoryReplSet;

function basePolicy(overrides: Partial<CreateFundInput['policy']> = {}): CreateFundInput['policy'] {
  return {
    cycleUnit: 'WEEKLY',
    startDate: new Date(),
    visibility: 'INVITE_ONLY',
    shareChange: 'BOTH',
    nonPayment: 'TRACK_ONLY',
    joinLock: 'ALLOW',
    graceCycles: 0,
    penaltyPaisa: 0,
    suspendAfterMisses: 3,
    inactivityDays: 30,
    ...overrides,
  };
}

describe('fund service', () => {
  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri(), { dbName: 'samity_fund_service' });
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

  describe('createFund', () => {
    it('creates a fund + admin membership, ledger, deposit, snapshot and audit entry when initialShares > 0', async () => {
      const admin = await User.create({ phone: '+8801700000001', name: 'Admin', passwordHash: 'hash' });

      const result = await createFund(String(admin._id), {
        name: 'My Samity',
        faceValue: 20000,
        policy: basePolicy(),
        initialShares: 5,
      });

      expect(result.nav).toBe(20000); // anchors to faceValue: cyclesElapsed=0 -> max(.,1)=1

      const fund = await Fund.findById(result.fundId).lean();
      expect(fund).toMatchObject({ name: 'My Samity', faceValue: 20000, status: 'ACTIVE', originType: 'NEW' });

      const membership = await Membership.findById(result.membershipId).lean();
      expect(membership).toMatchObject({
        role: 'admin',
        status: 'ACTIVE',
        shares: 5,
        joinNav: 20000,
        paidThroughCycle: 0,
      });

      const cashIn = await LedgerEntry.findOne({ fundId: result.fundId, kind: 'CASH_IN' }).lean();
      expect(cashIn).toMatchObject({ amount: 100000, membershipId: new Types.ObjectId(result.membershipId) });

      const sharesIssued = await LedgerEntry.findOne({ fundId: result.fundId, kind: 'SHARES_ISSUED' }).lean();
      expect(sharesIssued).toMatchObject({ shares: 5, membershipId: new Types.ObjectId(result.membershipId) });

      const deposit = await Deposit.findOne({ fundId: result.fundId }).lean();
      expect(deposit).toMatchObject({
        type: 'BUY_IN',
        amount: 100000,
        sharesRequested: 5,
        sharesIssued: 5,
        status: 'VERIFIED',
        screenshotUrl: 'FOUNDING',
      });

      const snapshot = await NavSnapshot.findOne({ fundId: result.fundId }).lean();
      expect(snapshot).toMatchObject({
        reason: 'INIT',
        nav: 20000,
        totalShares: 5,
        totalAssets: 100000,
        cash: 100000,
        investedAtCost: 0,
      });

      const audit = await AuditLog.findOne({ fundId: result.fundId, action: 'FUND_CREATE' }).lean();
      expect(audit).toMatchObject({
        after: { name: 'My Samity', faceValue: 20000, initialShares: 5 },
      });

      const nav = await computeNav(result.fundId);
      expect(result.nav).toBe(nav.nav);
    });

    it('creates a fund with no ledger entries when initialShares === 0, NAV anchored to faceValue', async () => {
      const admin = await User.create({ phone: '+8801700000002', name: 'Admin', passwordHash: 'hash' });

      const result = await createFund(String(admin._id), {
        name: 'Zero Share Fund',
        faceValue: 30000,
        policy: basePolicy(),
        initialShares: 0,
      });

      expect(result.nav).toBe(30000);

      await expect(LedgerEntry.countDocuments({ fundId: result.fundId, kind: 'CASH_IN' })).resolves.toBe(0);
      await expect(LedgerEntry.countDocuments({ fundId: result.fundId, kind: 'SHARES_ISSUED' })).resolves.toBe(0);
      await expect(Deposit.countDocuments({ fundId: result.fundId })).resolves.toBe(0);

      const membership = await Membership.findById(result.membershipId).lean();
      expect(membership).toMatchObject({ shares: 0, role: 'admin', status: 'ACTIVE' });

      const snapshot = await NavSnapshot.findOne({ fundId: result.fundId }).lean();
      expect(snapshot).toMatchObject({
        nav: 30000,
        totalShares: 0,
        totalAssets: 0,
        cash: 0,
        investedAtCost: 0,
      });

      const nav = await computeNav(result.fundId);
      expect(result.nav).toBe(nav.nav);
    });
  });

  describe('importFund', () => {
    // Fixed offset from "now" so currentCycleIndex is deterministic without depending on a
    // frozen clock: 30 days / 7-day cycles = cycle 4, with a ~2-day buffer either side of the
    // nearest cycle boundary (28d, 35d) to absorb the real time elapsed while the test runs.
    const START_DATE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const EXPECTED_CURRENT_CYCLE = 4;

    it('seeds admin + roster members, ledger entries, investments and NAV correctly', async () => {
      const admin = await User.create({ phone: '+8801700000010', name: 'Admin', passwordHash: 'hash' });
      const existingActive = await User.create({
        phone: '+8801700000099',
        name: 'Existing Active Member',
        passwordHash: 'hash',
        status: 'ACTIVE',
      });

      const input: ImportFundInput = {
        name: 'Imported Samity',
        faceValue: 20000,
        policy: basePolicy({ startDate: START_DATE }),
        adminShares: 5,
        adminCyclesBehind: 1, // paidThrough = 4 - 1 = 3
        openingCashPaisa: 500000,
        members: [
          // dropped: matches caller's own phone
          { name: 'Admin Self', phone: admin.phone, shares: 99, cyclesBehind: 0 },
          // first occurrence of this phone wins
          { name: 'Member A', phone: '+8801700000011', shares: 3, cyclesBehind: 0 },
          // dropped: duplicate phone of Member A
          { name: 'Member A Dup', phone: '+8801700000011', shares: 7, cyclesBehind: 0 },
          // links to an existing ACTIVE user; cyclesBehind exceeds currentCycle -> floors at 0
          { name: 'Member B', phone: existingActive.phone, shares: 2, cyclesBehind: 10 },
        ],
        investments: [{ destination: 'Shop stock', amountCost: 100000, expectedReturn: 20000 }],
        successorPhone: undefined,
      } as ImportFundInput;

      const result = await importFund(String(admin._id), input);

      expect(result.memberCount).toBe(3); // admin + Member A + Member B
      expect(result.invitedCount).toBe(1); // only Member A is a fresh ghost
      expect(result.nav).toBe(80000); // faceValue(20000) * currentCycle(4) + 0 profit/share

      const fund = await Fund.findById(result.fundId).lean();
      expect(fund).toMatchObject({ originType: 'IMPORTED' });
      expect(fund?.genesisAt).toBeInstanceOf(Date);

      // Admin membership
      const adminMembership = await Membership.findById(result.membershipId).lean();
      expect(adminMembership).toMatchObject({ role: 'admin', status: 'ACTIVE', shares: 5, paidThroughCycle: 3 });

      // Member A: ghost created (didn't exist before)
      const ghostUser = await User.findOne({ phone: '+8801700000011' }).lean();
      expect(ghostUser).toMatchObject({ status: 'INVITED', name: 'Member A', passwordHash: '!' });
      const memberAMembership = await Membership.findOne({ fundId: result.fundId, userId: ghostUser!._id }).lean();
      expect(memberAMembership).toMatchObject({
        role: 'member',
        status: 'ACTIVE',
        shares: 3,
        paidThroughCycle: EXPECTED_CURRENT_CYCLE,
      });

      // Member B: linked to the pre-existing ACTIVE user, cyclesBehind floors paidThrough at 0
      const memberBMembership = await Membership.findOne({ fundId: result.fundId, userId: existingActive._id }).lean();
      expect(memberBMembership).toMatchObject({ role: 'member', status: 'ACTIVE', shares: 2, paidThroughCycle: 0 });

      // Admin isn't duplicated as a roster member
      await expect(Membership.countDocuments({ fundId: result.fundId, userId: admin._id })).resolves.toBe(1);
      await expect(Membership.countDocuments({ fundId: result.fundId })).resolves.toBe(3);

      // SHARES_ISSUED ledger entries: one per seeded member, summing to totalShares
      const sharesIssued = await LedgerEntry.find({ fundId: result.fundId, kind: 'SHARES_ISSUED' }).lean();
      expect(sharesIssued).toHaveLength(3);
      expect(sharesIssued.reduce((sum, e) => sum + e.shares, 0)).toBe(10);

      // OPENING_CONTRIBUTION: only for members with paidThroughCycle > 0 (admin, Member A — not Member B)
      const openingContributions = await LedgerEntry.find({ fundId: result.fundId, kind: 'OPENING_CONTRIBUTION' }).lean();
      expect(openingContributions).toHaveLength(2);
      expect(openingContributions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ membershipId: adminMembership!._id, amount: 300000 }), // 3 * 5 * 20000
          expect.objectContaining({ membershipId: memberAMembership!._id, amount: 240000 }), // 4 * 3 * 20000
        ]),
      );
      await expect(
        LedgerEntry.countDocuments({ fundId: result.fundId, kind: 'OPENING_CONTRIBUTION', membershipId: memberBMembership!._id }),
      ).resolves.toBe(0);

      // OPENING_CASH
      const openingCash = await LedgerEntry.findOne({ fundId: result.fundId, kind: 'OPENING_CASH' }).lean();
      expect(openingCash).toMatchObject({ amount: 500000 });

      // Investments: created ACTIVE, no CASH_OUT_INVEST (opening cash already excludes them)
      await expect(Investment.countDocuments({ fundId: result.fundId, state: 'ACTIVE' })).resolves.toBe(1);
      const investment = await Investment.findOne({ fundId: result.fundId }).lean();
      expect(investment).toMatchObject({ amountCost: 100000, destination: 'Shop stock', state: 'ACTIVE' });
      await expect(LedgerEntry.countDocuments({ fundId: result.fundId, kind: 'CASH_OUT_INVEST' })).resolves.toBe(0);

      // Final NAV/snapshot
      const snapshot = await NavSnapshot.findOne({ fundId: result.fundId }).lean();
      expect(snapshot).toMatchObject({
        reason: 'INIT',
        nav: 80000,
        totalShares: 10,
        totalAssets: 600000,
        cash: 500000,
        investedAtCost: 100000,
      });

      const audit = await AuditLog.findOne({ fundId: result.fundId, action: 'FUND_IMPORT' }).lean();
      expect(audit).toMatchObject({
        after: { memberCount: 3, invitedCount: 1, openingCashPaisa: 500000, investments: 1, nav: 80000 },
      });

      const nav = await computeNav(result.fundId);
      expect(result.nav).toBe(nav.nav);
    });

    it('does not append an OPENING_CASH entry when openingCashPaisa is 0', async () => {
      const admin = await User.create({ phone: '+8801700000020', name: 'Admin', passwordHash: 'hash' });

      const input: ImportFundInput = {
        name: 'Cashless Import',
        faceValue: 20000,
        policy: basePolicy({ startDate: START_DATE }),
        adminShares: 4,
        adminCyclesBehind: 0,
        openingCashPaisa: 0,
        members: [],
        investments: [],
      } as ImportFundInput;

      const result = await importFund(String(admin._id), input);

      await expect(LedgerEntry.countDocuments({ fundId: result.fundId, kind: 'OPENING_CASH' })).resolves.toBe(0);
      const nav = await computeNav(result.fundId);
      expect(nav.cash).toBe(0);
      expect(nav.totalAssets).toBe(0);
    });
  });
});
