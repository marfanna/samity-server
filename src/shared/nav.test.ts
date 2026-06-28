import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Lock } from '../app/modules/_infra/lock.model';
import { Fund } from '../app/modules/fund/fund.model';
import { Investment } from '../app/modules/investment/investment.model';
import { LedgerEntry } from '../app/modules/ledger/ledgerEntry.model';
import { withFundLock } from './fundLock';
import { appendLedger } from './ledger';
import { computeNav } from './nav';

const actorId = new Types.ObjectId();

let replSet: MongoMemoryReplSet;

async function createFund(faceValue = 20000): Promise<Types.ObjectId> {
  const fund = await Fund.create({
    name: 'Phase 08 Test Fund',
    faceValue,
    policy: {
      cycleUnit: 'WEEKLY',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
    },
    createdBy: actorId,
  });

  return fund._id;
}

async function appendOpeningCapital(fundId: Types.ObjectId, cash: number, shares: number): Promise<void> {
  await appendLedger({ fundId, kind: 'CASH_IN', amount: cash, createdBy: actorId });
  await appendLedger({ fundId, kind: 'SHARES_ISSUED', shares, createdBy: actorId });
}

describe('computeNav', () => {
  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri(), { dbName: 'samity_phase08' });
  }, 120_000);

  beforeEach(async () => {
    await Promise.all([Fund.deleteMany({}), LedgerEntry.deleteMany({}), Investment.deleteMany({}), Lock.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  it('anchors to face value when a fund has no issued shares', async () => {
    const fundId = await createFund(25000);

    await expect(computeNav(fundId)).resolves.toEqual({
      nav: 25000,
      totalShares: 0,
      totalAssets: 0,
      cash: 0,
      investedAtCost: 0,
    });
  });

  it('derives founding NAV from ledger cash and issued shares', async () => {
    const fundId = await createFund(20000);
    await appendOpeningCapital(fundId, 100000, 5);

    await expect(computeNav(fundId)).resolves.toMatchObject({
      nav: 20000,
      totalShares: 5,
      totalAssets: 100000,
      cash: 100000,
      investedAtCost: 0,
    });
  });

  it('does not count dues markers or penalties as NAV assets', async () => {
    const fundId = await createFund(20000);
    await appendOpeningCapital(fundId, 100000, 5);
    await appendLedger({ fundId, kind: 'DUES_PAID', cyclesCovered: 1, amount: 900000, createdBy: actorId });
    await appendLedger({ fundId, kind: 'PENALTY', amount: 5000, createdBy: actorId });

    await expect(computeNav(fundId)).resolves.toMatchObject({
      nav: 20000,
      totalAssets: 100000,
      cash: 100000,
    });
  });

  it('keeps NAV unchanged when cash moves into an active investment at cost', async () => {
    const fundId = await createFund(20000);
    await appendOpeningCapital(fundId, 100000, 5);
    await appendLedger({ fundId, kind: 'CASH_OUT_INVEST', amount: -60000, createdBy: actorId });
    await Investment.create({
      fundId,
      amountCost: 60000,
      destination: 'Inventory purchase',
      recordedBy: actorId,
      state: 'ACTIVE',
    });

    await expect(computeNav(fundId)).resolves.toMatchObject({
      nav: 20000,
      totalShares: 5,
      totalAssets: 100000,
      cash: 40000,
      investedAtCost: 60000,
    });
  });

  it('realizes profit through NAV when an investment return lands', async () => {
    const fundId = await createFund(20000);
    await appendOpeningCapital(fundId, 100000, 5);
    await appendLedger({ fundId, kind: 'CASH_OUT_INVEST', amount: -60000, createdBy: actorId });
    await Investment.create({
      fundId,
      amountCost: 60000,
      destination: 'Inventory purchase',
      actualReturn: 75000,
      profitLoss: 15000,
      recordedBy: actorId,
      returnedBy: actorId,
      returnedAt: new Date(),
      state: 'RETURNED',
    });
    await appendLedger({ fundId, kind: 'INVEST_RETURN', amount: 75000, createdBy: actorId });

    await expect(computeNav(fundId)).resolves.toMatchObject({
      nav: 23000,
      totalShares: 5,
      totalAssets: 115000,
      cash: 115000,
      investedAtCost: 0,
    });
  });

  it('realizes loss through NAV when an investment returns below cost', async () => {
    const fundId = await createFund(20000);
    await appendOpeningCapital(fundId, 100000, 5);
    await appendLedger({ fundId, kind: 'CASH_OUT_INVEST', amount: -60000, createdBy: actorId });
    await Investment.create({
      fundId,
      amountCost: 60000,
      destination: 'Inventory purchase',
      actualReturn: 45000,
      profitLoss: -15000,
      recordedBy: actorId,
      returnedBy: actorId,
      returnedAt: new Date(),
      state: 'RETURNED',
    });
    await appendLedger({ fundId, kind: 'INVEST_RETURN', amount: 45000, createdBy: actorId });

    await expect(computeNav(fundId)).resolves.toMatchObject({
      nav: 17000,
      totalShares: 5,
      totalAssets: 85000,
      cash: 85000,
      investedAtCost: 0,
    });
  });

  it('sees uncommitted ledger writes when called with the active transaction session', async () => {
    const fundId = await createFund(20000);
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        await appendLedger({ fundId, kind: 'CASH_IN', amount: 100000, createdBy: actorId }, session);
        await appendLedger({ fundId, kind: 'SHARES_ISSUED', shares: 5, createdBy: actorId }, session);

        await expect(computeNav(fundId, session)).resolves.toMatchObject({
          nav: 20000,
          totalShares: 5,
          totalAssets: 100000,
          cash: 100000,
        });

        await expect(computeNav(fundId)).resolves.toMatchObject({
          nav: 20000,
          totalShares: 0,
          totalAssets: 0,
          cash: 0,
        });
      });
    } finally {
      await session.endSession();
    }

    await expect(computeNav(fundId)).resolves.toMatchObject({
      nav: 20000,
      totalShares: 5,
      totalAssets: 100000,
      cash: 100000,
    });
  });

  it('blocks updates to append-only ledger entries', async () => {
    const fundId = await createFund(20000);
    const entry = await appendLedger({ fundId, kind: 'CASH_IN', amount: 100000, createdBy: actorId });

    await expect(LedgerEntry.updateOne({ _id: entry._id }, { $set: { amount: 1 } })).rejects.toThrow(
      'LedgerEntry is append-only',
    );
  });

  it('fails fast on concurrent writes under the same per-fund advisory lock', async () => {
    const fundId = new Types.ObjectId().toString();
    let releaseFirstLock: (() => void) | undefined;

    const firstWriter = withFundLock(fundId, async (fencingSeq) => {
      expect(fencingSeq).toBe(1);
      await new Promise<void>((resolve) => {
        releaseFirstLock = resolve;
      });
      return 'first-writer-done';
    });

    await waitForLock(`fund:${fundId}:write`);

    await expect(withFundLock(fundId, async () => 'second-writer-done')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      statusCode: 409,
    });

    releaseFirstLock?.();
    await expect(firstWriter).resolves.toBe('first-writer-done');
    await expect(Lock.countDocuments({ _id: `fund:${fundId}:write` })).resolves.toBe(0);
  });
});

async function waitForLock(lockId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const exists = await Lock.exists({ _id: lockId });
    if (exists) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error(`lock was not acquired: ${lockId}`);
}
