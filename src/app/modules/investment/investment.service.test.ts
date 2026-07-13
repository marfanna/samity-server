import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../audit/auditLog.model';
import { Lock } from '../_infra/lock.model';
import { Fund } from '../fund/fund.model';
import { LedgerEntry } from '../ledger/ledgerEntry.model';
import { NavSnapshot } from '../nav/navSnapshot.model';
import { appendLedger } from '../../../shared/ledger';
import { computeNav } from '../../../shared/nav';
import { Investment } from './investment.model';
import { recordInvestment, recordReturn } from './investment.service';

const actorId = new Types.ObjectId();

let replSet: MongoMemoryReplSet;

async function createFund(faceValue = 20000): Promise<Types.ObjectId> {
  const fund = await Fund.create({
    name: 'Investment Test Fund',
    faceValue,
    policy: {
      cycleUnit: 'WEEKLY',
      startDate: new Date(),
    },
    createdBy: actorId,
  });
  return fund._id;
}

async function appendOpeningCapital(fundId: Types.ObjectId, cash: number, shares: number): Promise<void> {
  await appendLedger({ fundId, kind: 'CASH_IN', amount: cash, createdBy: actorId });
  await appendLedger({ fundId, kind: 'SHARES_ISSUED', shares, createdBy: actorId });
}

/** Seed an ACTIVE investment the same way recordInvestment would (Investment doc + CASH_OUT_INVEST). */
async function seedActiveInvestment(fundId: Types.ObjectId, amountCost: number): Promise<Types.ObjectId> {
  const investment = await Investment.create({
    fundId,
    amountCost,
    destination: 'Inventory purchase',
    recordedBy: actorId,
    state: 'ACTIVE',
  });
  await appendLedger({ fundId, kind: 'CASH_OUT_INVEST', amount: -amountCost, createdBy: actorId });
  return investment._id;
}

describe('investment service', () => {
  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri(), { dbName: 'samity_investment_service' });
  }, 120_000);

  beforeEach(async () => {
    await Promise.all([
      AuditLog.deleteMany({}),
      Fund.deleteMany({}),
      Investment.deleteMany({}),
      LedgerEntry.deleteMany({}),
      Lock.deleteMany({}),
      NavSnapshot.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  describe('recordInvestment', () => {
    it('creates an ACTIVE investment, appends a negative CASH_OUT_INVEST entry, and conserves totalAssets/NAV', async () => {
      const fundId = await createFund(20000);
      await appendOpeningCapital(fundId, 100000, 5);

      const navBefore = await computeNav(fundId);
      expect(navBefore).toMatchObject({ nav: 20000, cash: 100000, investedAtCost: 0, totalAssets: 100000 });

      const result = await recordInvestment(String(actorId), String(fundId), {
        destination: 'Shop stock',
        amountCost: 60000,
      });

      const investment = await Investment.findById(result.investmentId).lean();
      expect(investment).toMatchObject({ state: 'ACTIVE', amountCost: 60000, destination: 'Shop stock' });

      const ledgerEntry = await LedgerEntry.findOne({ fundId, kind: 'CASH_OUT_INVEST' }).lean();
      expect(ledgerEntry).toMatchObject({
        amount: -60000,
        refType: 'INVESTMENT',
        refId: new Types.ObjectId(result.investmentId),
      });

      const navAfter = await computeNav(fundId);
      // Cash moved into an investment at cost — principal is schedule-driven, not cash-driven,
      // so the price-per-share NAV does not move, and cash+invested (totalAssets) is conserved.
      expect(navAfter.nav).toBe(navBefore.nav);
      expect(navAfter.totalAssets).toBe(navBefore.totalAssets);
      expect(navAfter.investedAtCost).toBe(navBefore.investedAtCost + 60000);
      expect(navAfter.cash).toBe(navBefore.cash - 60000);
      expect(result.nav).toBe(navAfter.nav);

      const snapshot = await NavSnapshot.findOne({ fundId, reason: 'INVEST' }).lean();
      expect(snapshot).toMatchObject({
        nav: navAfter.nav,
        totalShares: 5,
        totalAssets: 100000,
        cash: 40000,
        investedAtCost: 60000,
      });
      expect(snapshot?.meta).toMatchObject({ investmentId: result.investmentId });

      const audit = await AuditLog.findOne({ fundId, action: 'INVESTMENT_RECORD' }).lean();
      expect(audit).toBeTruthy();
    });
  });

  describe('recordReturn', () => {
    it('profit case: RETURNED with positive profitLoss, INVEST_RETURN ledger entry, higher NAV via profit-per-share', async () => {
      const fundId = await createFund(20000);
      await appendOpeningCapital(fundId, 100000, 5);
      const investmentId = await seedActiveInvestment(fundId, 60000);

      const result = await recordReturn(String(actorId), String(fundId), String(investmentId), {
        actualReturn: 75000,
        screenshotUrl: 'proof/return-1.png',
      });

      expect(result.profitLoss).toBe(15000);

      const investment = await Investment.findById(investmentId).lean();
      expect(investment).toMatchObject({
        state: 'RETURNED',
        actualReturn: 75000,
        profitLoss: 15000,
        returnScreenshotUrl: 'proof/return-1.png',
      });
      expect(investment?.returnedBy).toEqual(actorId);
      expect(investment?.returnedAt).toBeInstanceOf(Date);

      const ledgerEntry = await LedgerEntry.findOne({ fundId, kind: 'INVEST_RETURN' }).lean();
      expect(ledgerEntry).toMatchObject({ amount: 75000, refId: investmentId });

      const nav = await computeNav(fundId);
      // 20000 schedule principal + round(15000 profit / 5 shares) = 23000 — matches nav.test.ts's
      // equivalent scenario, confirming the profit-per-share term realizes through NAV.
      expect(nav).toMatchObject({ nav: 23000, totalShares: 5, totalAssets: 115000, cash: 115000, investedAtCost: 0 });
      expect(result.nav).toBe(nav.nav);

      const snapshot = await NavSnapshot.findOne({ fundId, reason: 'INVEST_RETURN' }).lean();
      expect(snapshot).toMatchObject({ nav: 23000 });
      expect(snapshot?.meta).toMatchObject({ profitLoss: 15000 });
    });

    it('loss case: NAV ends up below the pure schedule principal', async () => {
      const fundId = await createFund(20000);
      await appendOpeningCapital(fundId, 100000, 5);
      const investmentId = await seedActiveInvestment(fundId, 60000);

      const result = await recordReturn(String(actorId), String(fundId), String(investmentId), {
        actualReturn: 45000,
        screenshotUrl: 'proof/return-loss.png',
      });

      expect(result.profitLoss).toBe(-15000);

      const investment = await Investment.findById(investmentId).lean();
      expect(investment).toMatchObject({ state: 'RETURNED', actualReturn: 45000, profitLoss: -15000 });

      const nav = await computeNav(fundId);
      // 20000 schedule principal + round(-15000 / 5) = 17000 — strictly below the 20000 the
      // schedule alone would imply, proving losses actually depress NAV.
      expect(nav.nav).toBe(17000);
      expect(nav.nav).toBeLessThan(20000);
    });

    it('total-loss case: actualReturn=0 is accepted by the service and yields profitLoss = -amountCost', async () => {
      const fundId = await createFund(20000);
      await appendOpeningCapital(fundId, 100000, 5);
      const investmentId = await seedActiveInvestment(fundId, 60000);

      const result = await recordReturn(String(actorId), String(fundId), String(investmentId), {
        actualReturn: 0,
        screenshotUrl: 'proof/total-loss.png',
      });

      expect(result.profitLoss).toBe(-60000);

      const investment = await Investment.findById(investmentId).lean();
      expect(investment).toMatchObject({ state: 'RETURNED', actualReturn: 0, profitLoss: -60000 });

      const ledgerEntry = await LedgerEntry.findOne({ fundId, kind: 'INVEST_RETURN' }).lean();
      expect(ledgerEntry).toMatchObject({ amount: 0 });

      const nav = await computeNav(fundId);
      // 20000 + round(-60000/5) = 8000
      expect(nav.nav).toBe(8000);
      expect(nav.totalAssets).toBe(40000); // the 60000 principal is simply gone
    });

    it('rejects returning an investment that is not ACTIVE', async () => {
      const fundId = await createFund(20000);
      await appendOpeningCapital(fundId, 100000, 5);
      const investmentId = await seedActiveInvestment(fundId, 60000);

      await recordReturn(String(actorId), String(fundId), String(investmentId), {
        actualReturn: 75000,
        screenshotUrl: 'proof/first.png',
      });

      await expect(
        recordReturn(String(actorId), String(fundId), String(investmentId), {
          actualReturn: 10000,
          screenshotUrl: 'proof/second.png',
        }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT', statusCode: 409 });
    });
  });
});
