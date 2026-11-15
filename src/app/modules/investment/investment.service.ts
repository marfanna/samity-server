import mongoose, { Types } from 'mongoose';
import { AuditLog } from '../audit/auditLog.model';
import { NavSnapshot } from '../nav/navSnapshot.model';
import { appendLedger } from '../../../shared/ledger';
import { computeNav } from '../../../shared/nav';
import { withFundLock } from '../../../shared/fundLock';
import { notifyFundMembers } from '../../../shared/notify';
import { ApiError } from '../../../utils/ApiError';
import { Investment } from './investment.model';
import { LedgerEntry } from '../ledger/ledgerEntry.model';
import type { CorrectReturnInput, RecordInvestmentInput, RecordReturnInput } from './investment.validation';

function oid(id: string | Types.ObjectId): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

export async function recordInvestment(actorId: string, fundId: string, input: RecordInvestmentInput) {
  return withFundLock(fundId, async () => {
    const session = await mongoose.startSession();
    try {
      let result!: { investmentId: string; nav: number };

      await session.withTransaction(async () => {
        const [investment] = await Investment.create(
          [
            {
              fundId: oid(fundId),
              amountCost: input.amountCost,
              destination: input.destination,
              expectedReturn: input.expectedReturn ?? 0,
              expectedDate: input.expectedDate ? new Date(input.expectedDate) : undefined,
              state: 'ACTIVE',
              recordedBy: oid(actorId),
            },
          ],
          { session },
        );

        // Cash flows OUT — stored as negative so the ledger sum (cash) decreases correctly.
        await appendLedger(
          {
            fundId,
            kind: 'CASH_OUT_INVEST',
            amount: -input.amountCost,
            refType: 'INVESTMENT',
            refId: investment!._id,
            createdBy: actorId,
          },
          session,
        );

        const nav = await computeNav(fundId, session);
        await NavSnapshot.create(
          [
            {
              fundId: oid(fundId),
              nav: nav.nav,
              totalShares: nav.totalShares,
              totalAssets: nav.totalAssets,
              cash: nav.cash,
              investedAtCost: nav.investedAtCost,
              reason: 'INVEST',
              meta: { investmentId: String(investment!._id) },
            },
          ],
          { session },
        );

        await AuditLog.create(
          [
            {
              fundId: oid(fundId),
              actorId: oid(actorId),
              action: 'INVESTMENT_RECORD',
              refType: 'INVESTMENT',
              refId: investment!._id,
              after: {
                destination: input.destination,
                amountCost: input.amountCost,
                nav: nav.nav,
              },
            },
          ],
          { session },
        );

        result = { investmentId: String(investment!._id), nav: nav.nav };
      });

      notifyFundMembers(fundId, actorId, {
        type: 'INVESTMENT_RECORDED',
        title: 'New investment recorded',
        body: `৳${Math.round(input.amountCost / 100)} invested in ${input.destination}.`,
        fundId,
      });
      return result;
    } finally {
      await session.endSession();
    }
  });
}

export async function recordReturn(actorId: string, fundId: string, investmentId: string, input: RecordReturnInput) {
  return withFundLock(fundId, async () => {
    const session = await mongoose.startSession();
    try {
      let result!: { investmentId: string; profitLoss: number; nav: number };

      await session.withTransaction(async () => {
        const investment = await Investment.findOne({ _id: investmentId, fundId }).session(session);
        if (!investment) throw new ApiError(404, 'NOT_FOUND', 'investment not found');
        if (investment.state !== 'ACTIVE') {
          throw new ApiError(409, 'STATE_CONFLICT', 'investment is not active');
        }

        const profitLoss = input.actualReturn - investment.amountCost;

        // CAS guard: only update if still ACTIVE
        const updated = await Investment.updateOne(
          { _id: investment._id, state: 'ACTIVE' },
          {
            $set: {
              state: 'RETURNED',
              actualReturn: input.actualReturn,
              profitLoss,
              returnScreenshotUrl: input.screenshotUrl,
              returnedBy: oid(actorId),
              returnedAt: new Date(),
            },
          },
          { session },
        );
        if (updated.matchedCount === 0) {
          throw new ApiError(409, 'STATE_CONFLICT', 'investment already settled');
        }

        // Return cash flows IN — includes full profit/loss realized into the ledger.
        await appendLedger(
          {
            fundId,
            kind: 'INVEST_RETURN',
            amount: input.actualReturn,
            refType: 'INVESTMENT',
            refId: investment._id,
            createdBy: actorId,
          },
          session,
        );

        const nav = await computeNav(fundId, session);
        await NavSnapshot.create(
          [
            {
              fundId: oid(fundId),
              nav: nav.nav,
              totalShares: nav.totalShares,
              totalAssets: nav.totalAssets,
              cash: nav.cash,
              investedAtCost: nav.investedAtCost,
              reason: 'INVEST_RETURN',
              meta: { investmentId, profitLoss, nav: nav.nav },
            },
          ],
          { session },
        );

        await AuditLog.create(
          [
            {
              fundId: oid(fundId),
              actorId: oid(actorId),
              action: 'INVESTMENT_RETURN',
              refType: 'INVESTMENT',
              refId: investment._id,
              before: { state: 'ACTIVE', amountCost: investment.amountCost },
              after: { state: 'RETURNED', actualReturn: input.actualReturn, profitLoss, nav: nav.nav },
            },
          ],
          { session },
        );

        result = { investmentId, profitLoss, nav: nav.nav };
      });

      notifyFundMembers(fundId, actorId, {
        type: 'INVESTMENT_RETURNED',
        title: 'Investment returned',
        body: `NAV updated to ৳${(result.nav / 100).toFixed(2)} after return.`,
        fundId,
      });
      return result;
    } finally {
      await session.endSession();
    }
  });
}

/**
 * Fix a mistyped return on an already-returned investment (admin only). Append-only: the
 * current INVEST_RETURN is reversed and the correct one recorded, then the cached
 * actualReturn/profitLoss are updated (compare-and-set) so NAV's profit pool follows.
 */
export async function correctReturn(actorId: string, fundId: string, investmentId: string, input: CorrectReturnInput) {
  return withFundLock(fundId, async () => {
    const session = await mongoose.startSession();
    try {
      let result!: { investmentId: string; actualReturn: number; profitLoss: number; nav: number };

      await session.withTransaction(async () => {
        const investment = await Investment.findOne({ _id: investmentId, fundId }).session(session).lean();
        if (!investment) throw new ApiError(404, 'NOT_FOUND', 'investment not found');
        if (investment.state !== 'RETURNED') {
          throw new ApiError(409, 'STATE_CONFLICT', 'only a returned investment can be corrected');
        }
        if (investment.actualReturn === input.actualReturn) {
          throw new ApiError(400, 'VALIDATION_ERROR', 'that is already the recorded return');
        }

        // The live return entry = the latest INVEST_RETURN for this investment not yet reversed.
        const returns = await LedgerEntry.find({ fundId: oid(fundId), kind: 'INVEST_RETURN', refId: investment._id })
          .sort({ at: -1, _id: -1 })
          .session(session)
          .lean();
        const reversed = new Set(
          (
            await LedgerEntry.find({ reversalOf: { $in: returns.map((r) => r._id) } }, { reversalOf: 1 })
              .session(session)
              .lean()
          ).map((r) => String(r.reversalOf)),
        );
        const live = returns.find((r) => !reversed.has(String(r._id)));
        if (!live || live.amount !== investment.actualReturn) {
          throw new ApiError(409, 'STATE_CONFLICT', 'ledger and investment disagree — contact support');
        }

        const profitLoss = input.actualReturn - investment.amountCost;
        const updated = await Investment.updateOne(
          { _id: investment._id, state: 'RETURNED', actualReturn: investment.actualReturn },
          { $set: { actualReturn: input.actualReturn, profitLoss } },
          { session },
        );
        if (updated.matchedCount === 0) throw new ApiError(409, 'STATE_CONFLICT', 'investment changed, retry');

        const reversal = await appendLedger(
          { fundId, kind: 'REVERSAL', amount: -live.amount, refType: 'CORRECTION', reversalOf: live._id, createdBy: actorId },
          session,
        );
        const corrected = await appendLedger(
          { fundId, kind: 'INVEST_RETURN', amount: input.actualReturn, refType: 'INVESTMENT', refId: investment._id, createdBy: actorId },
          session,
        );

        const nav = await computeNav(fundId, session);
        await NavSnapshot.create(
          [
            {
              fundId: oid(fundId),
              nav: nav.nav,
              totalShares: nav.totalShares,
              totalAssets: nav.totalAssets,
              cash: nav.cash,
              investedAtCost: nav.investedAtCost,
              reason: 'CORRECTION',
              meta: { investmentId, profitLoss, reversalOf: String(live._id) },
            },
          ],
          { session },
        );

        await AuditLog.create(
          [
            {
              fundId: oid(fundId),
              actorId: oid(actorId),
              action: 'INVEST_RETURN_CORRECT',
              refType: 'INVESTMENT',
              refId: investment._id,
              before: { actualReturn: investment.actualReturn, profitLoss: investment.profitLoss },
              after: {
                actualReturn: input.actualReturn,
                profitLoss,
                nav: nav.nav,
                reason: input.reason,
                reversalEntryId: String(reversal._id),
                correctedEntryId: String(corrected._id),
              },
            },
          ],
          { session },
        );

        result = { investmentId, actualReturn: input.actualReturn, profitLoss, nav: nav.nav };
      });

      notifyFundMembers(fundId, actorId, {
        type: 'INVESTMENT_RETURNED',
        title: 'Investment return corrected',
        body: `NAV updated to ৳${(result.nav / 100).toFixed(2)} after a correction.`,
        fundId,
      });
      return result;
    } finally {
      await session.endSession();
    }
  });
}

export async function listInvestments(fundId: string) {
  const investments = await Investment.find({ fundId }).sort({ createdAt: -1 }).lean();
  return investments.map((inv) => ({
    id: String(inv._id),
    destination: inv.destination,
    amountCost: inv.amountCost,
    expectedReturn: inv.expectedReturn,
    expectedDate: inv.expectedDate?.toISOString(),
    state: inv.state,
    actualReturn: inv.state === 'RETURNED' || inv.state === 'SETTLED' ? inv.actualReturn : null,
    profitLoss: inv.state === 'RETURNED' || inv.state === 'SETTLED' ? inv.profitLoss : null,
    createdAt: inv.createdAt,
  }));
}
