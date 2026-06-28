import { allModels } from '../app/modules/registry';

/**
 * Create indexes explicitly on boot (autoIndex is off — no surprise builds in prod).
 * Covers every registered collection: domain models + infra/TTL collections.
 */
export async function dbInit(): Promise<void> {
  await Promise.all(allModels.map((m) => m.syncIndexes()));

  // eslint-disable-next-line no-console
  console.log(`✅ Indexes synced across ${allModels.length} collections`);
}
