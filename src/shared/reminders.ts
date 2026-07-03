import cron from 'node-cron';
import { Fund } from '../app/modules/fund/fund.model';
import { notifyFundMembers } from './notify';

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC+6, no DST

/** ISO weekday (1=Mon…7=Sun) for "today" in Dhaka. */
function dhakaWeekday(): number {
  const d = new Date(Date.now() + DHAKA_OFFSET_MS);
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/**
 * Daily 9am (Asia/Dhaka) reminder: for every ACTIVE weekly fund whose collection day is
 * today, notify all active members that their contribution is due. Fires only while the
 * server is running — deploy the backend as a long-lived process for this to work.
 */
export function startReminders(): void {
  cron.schedule(
    '0 9 * * *',
    async () => {
      try {
        const weekday = dhakaWeekday();
        const funds = await Fund.find(
          { status: 'ACTIVE', 'policy.cycleUnit': 'WEEKLY', 'policy.collectionWeekday': weekday },
          { name: 1 },
        ).lean();
        for (const f of funds) {
          notifyFundMembers(String(f._id), '', {
            type: 'DUES_REMINDER',
            title: 'Payment due today',
            body: `This week's contribution for ${f.name} is due today.`,
            fundId: String(f._id),
          });
        }
        // eslint-disable-next-line no-console
        console.log(`[reminders] weekday ${weekday}: notified ${funds.length} fund(s)`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[reminders] failed:', err instanceof Error ? err.message : err);
      }
    },
    { timezone: 'Asia/Dhaka' },
  );
}
