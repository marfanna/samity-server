import mongoose from 'mongoose';
import cron from 'node-cron';
import { AuditLog } from '../app/modules/audit/auditLog.model';
import { Fund } from '../app/modules/fund/fund.model';
import { Membership } from '../app/modules/membership/membership.model';
import { appendLedger } from './ledger';
import { currentCycleIndex } from './cycle';
import { withFundLock } from './fundLock';
import { notifyFundManagers, notifyUser } from './notify';

/**
 * Daily sweep for funds with `policy.nonPayment` set to PENALTY or AUTO_SUSPEND (mutually
 * exclusive per fund — TRACK_ONLY funds are skipped entirely).
 *
 * `missedCycles` is a high-water mark of cycles missed past `graceCycles`, re-synced every run:
 *  - PENALTY charges only the newly-crossed delta since the last run (so a daily cron doesn't
 *    re-charge the same missed cycle every day), as a `PENALTY` ledger entry (does not count
 *    toward NAV assets — it's an amount owed, not cash collected; see `shared/nav.ts`).
 *  - AUTO_SUSPEND flips an ACTIVE membership to SUSPENDED once missed-past-grace cycles reach
 *    `suspendAfterMisses`. Suspension is not auto-lifted when a member catches up — an admin
 *    reactivates via `reactivateMembership`. Conversely, if an admin reactivates a member who
 *    is still behind, the next sweep re-suspends them (reactivate lifts suspension now; it does
 *    not exempt the member from future sweeps — change fund policy for a permanent exemption).
 */
export async function runNonPaymentSweep(now: Date = new Date()): Promise<void> {
  const funds = await Fund.find({
    status: 'ACTIVE',
    'policy.nonPayment': { $in: ['PENALTY', 'AUTO_SUSPEND'] },
  }).lean();

  for (const fund of funds) {
    await withFundLock(String(fund._id), async () => {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const currentCycle = currentCycleIndex(
            fund.policy.startDate,
            fund.policy.cycleUnit,
            now,
            fund.policy.collectionWeekday,
          );
          const memberships = await Membership.find({
            fundId: fund._id,
            status: 'ACTIVE',
            shares: { $gt: 0 },
          }).session(session);

          for (const m of memberships) {
            const behind = Math.max(0, currentCycle - m.paidThroughCycle);
            const actionable = Math.max(0, behind - fund.policy.graceCycles);
            const delta = actionable - m.missedCycles;

            if (delta > 0 && fund.policy.nonPayment === 'PENALTY' && fund.policy.penaltyPaisa > 0) {
              const amount = delta * fund.policy.penaltyPaisa;
              await appendLedger(
                {
                  fundId: fund._id,
                  kind: 'PENALTY',
                  amount,
                  cyclesCovered: delta,
                  membershipId: m._id,
                  refType: 'POLICY',
                  createdBy: fund.createdBy,
                },
                session,
              );
              void notifyUser(m.userId, {
                type: 'PENALTY_APPLIED',
                title: 'Late payment penalty applied',
                body: `৳${Math.round(amount / 100)} penalty for ${delta} missed cycle${delta !== 1 ? 's' : ''}.`,
                fundId: String(fund._id),
              });
            }

            if (actionable !== m.missedCycles) m.missedCycles = actionable;

            if (
              fund.policy.nonPayment === 'AUTO_SUSPEND' &&
              actionable >= fund.policy.suspendAfterMisses &&
              m.status === 'ACTIVE'
            ) {
              m.status = 'SUSPENDED';
              void notifyUser(m.userId, {
                type: 'MEMBERSHIP_SUSPENDED',
                title: 'Membership suspended',
                body: `Suspended for ${actionable} missed cycles of non-payment.`,
                fundId: String(fund._id),
              });
              notifyFundManagers(fund._id, undefined, {
                type: 'MEMBER_SUSPENDED',
                title: 'Member suspended',
                body: 'A member was auto-suspended for non-payment.',
                fundId: String(fund._id),
              });
              await AuditLog.create(
                [
                  {
                    fundId: fund._id,
                    actorId: fund.createdBy,
                    action: 'MEMBER_AUTO_SUSPEND',
                    refType: 'MEMBERSHIP',
                    refId: m._id,
                    before: { status: 'ACTIVE' },
                    after: { status: 'SUSPENDED', missedCycles: actionable },
                  },
                ],
                { session },
              );
            }

            if (m.isModified()) await m.save({ session });
          }
        });
      } finally {
        await session.endSession();
      }
    });
  }
}

/** Fires daily at 9:30am Asia/Dhaka — right after the 9am dues reminder in `reminders.ts`. */
export function startNonPaymentCron(): void {
  cron.schedule(
    '30 9 * * *',
    async () => {
      try {
        await runNonPaymentSweep();
        // eslint-disable-next-line no-console
        console.log('[nonPayment] sweep complete');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[nonPayment] sweep failed:', err instanceof Error ? err.message : err);
      }
    },
    { timezone: 'Asia/Dhaka' },
  );
}
