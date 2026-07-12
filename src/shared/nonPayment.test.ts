import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../app/modules/audit/auditLog.model';
import { Fund } from '../app/modules/fund/fund.model';
import { LedgerEntry } from '../app/modules/ledger/ledgerEntry.model';
import { Lock } from '../app/modules/_infra/lock.model';
import { Membership } from '../app/modules/membership/membership.model';
import { User } from '../app/modules/user/user.model';
import { runNonPaymentSweep } from './nonPayment';

const adminId = new Types.ObjectId();
const START = new Date('2026-01-01T00:00:00.000Z');
const THREE_CYCLES_LATER = new Date('2026-01-22T00:00:00.000Z'); // +21 days = 3 weekly cycles

let replSet: MongoMemoryReplSet;

async function createFund(nonPayment: 'PENALTY' | 'AUTO_SUSPEND' | 'TRACK_ONLY', overrides: Record<string, unknown> = {}) {
  const fund = await Fund.create({
    name: 'Non-payment Test Fund',
    faceValue: 20000,
    policy: {
      cycleUnit: 'WEEKLY',
      startDate: START,
      nonPayment,
      graceCycles: 0,
      penaltyPaisa: 5000,
      suspendAfterMisses: 2,
      ...overrides,
    },
    createdBy: adminId,
  });
  return fund._id;
}

async function createMember(fundId: Types.ObjectId) {
  const user = await User.create({ phone: `+8801700${Math.floor(Math.random() * 900000 + 100000)}`, name: 'Member', passwordHash: 'hash' });
  const membership = await Membership.create({
    userId: user._id,
    fundId,
    shares: 1,
    status: 'ACTIVE',
    paidThroughCycle: 0,
  });
  return membership._id;
}

describe('runNonPaymentSweep', () => {
  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri(), { dbName: 'samity_nonpayment' });
  }, 120_000);

  beforeEach(async () => {
    await Promise.all([
      Fund.deleteMany({}),
      Membership.deleteMany({}),
      LedgerEntry.deleteMany({}),
      AuditLog.deleteMany({}),
      User.deleteMany({}),
      Lock.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  it('charges a penalty for newly-missed cycles, once', async () => {
    const fundId = await createFund('PENALTY');
    const membershipId = await createMember(fundId);

    await runNonPaymentSweep(THREE_CYCLES_LATER);

    const entries = await LedgerEntry.find({ fundId, kind: 'PENALTY' }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ amount: 15000, cyclesCovered: 3 });

    const membership = await Membership.findById(membershipId).lean();
    expect(membership?.missedCycles).toBe(3);

    // Running again at the same instant must not re-charge (idempotent high-water mark).
    await runNonPaymentSweep(THREE_CYCLES_LATER);
    const entriesAfter = await LedgerEntry.find({ fundId, kind: 'PENALTY' }).lean();
    expect(entriesAfter).toHaveLength(1);
  });

  it('only charges the newly-crossed delta on a later run', async () => {
    const fundId = await createFund('PENALTY');
    await createMember(fundId);

    await runNonPaymentSweep(new Date('2026-01-08T00:00:00.000Z')); // 1 cycle behind
    await runNonPaymentSweep(THREE_CYCLES_LATER); // 3 cycles behind

    const entries = await LedgerEntry.find({ fundId, kind: 'PENALTY' }).sort({ at: 1 }).lean();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ amount: 5000, cyclesCovered: 1 });
    expect(entries[1]).toMatchObject({ amount: 10000, cyclesCovered: 2 });
  });

  it('auto-suspends once missed-past-grace cycles reach the threshold', async () => {
    const fundId = await createFund('AUTO_SUSPEND');
    const membershipId = await createMember(fundId);

    await runNonPaymentSweep(THREE_CYCLES_LATER);

    const membership = await Membership.findById(membershipId).lean();
    expect(membership?.status).toBe('SUSPENDED');
    expect(membership?.missedCycles).toBe(3);

    const audit = await AuditLog.find({ fundId, action: 'MEMBER_AUTO_SUSPEND' }).lean();
    expect(audit).toHaveLength(1);

    // Already suspended — a second run must not double-audit or error.
    await runNonPaymentSweep(THREE_CYCLES_LATER);
    const auditAfter = await AuditLog.find({ fundId, action: 'MEMBER_AUTO_SUSPEND' }).lean();
    expect(auditAfter).toHaveLength(1);
  });

  it('does not act before grace cycles are exhausted', async () => {
    const fundId = await createFund('AUTO_SUSPEND', { graceCycles: 3 });
    const membershipId = await createMember(fundId);

    await runNonPaymentSweep(THREE_CYCLES_LATER); // exactly 3 behind == grace, actionable=0

    const membership = await Membership.findById(membershipId).lean();
    expect(membership?.status).toBe('ACTIVE');
    expect(membership?.missedCycles).toBe(0);
  });

  it('does nothing for TRACK_ONLY funds', async () => {
    const fundId = await createFund('TRACK_ONLY');
    const membershipId = await createMember(fundId);

    await runNonPaymentSweep(THREE_CYCLES_LATER);

    const entries = await LedgerEntry.find({ fundId }).lean();
    expect(entries).toHaveLength(0);
    const membership = await Membership.findById(membershipId).lean();
    expect(membership?.status).toBe('ACTIVE');
    expect(membership?.missedCycles).toBe(0);
  });

  it('resyncs missedCycles down when a member catches back up', async () => {
    const fundId = await createFund('PENALTY');
    const membershipId = await createMember(fundId);

    await runNonPaymentSweep(THREE_CYCLES_LATER);
    await Membership.updateOne({ _id: membershipId }, { $set: { paidThroughCycle: 3 } });

    await runNonPaymentSweep(THREE_CYCLES_LATER); // now 0 behind

    const membership = await Membership.findById(membershipId).lean();
    expect(membership?.missedCycles).toBe(0);
    const entries = await LedgerEntry.find({ fundId, kind: 'PENALTY' }).lean();
    expect(entries).toHaveLength(1); // no new penalty from the resync
  });
});
