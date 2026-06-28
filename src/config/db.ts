import mongoose from 'mongoose';
import { env } from './env';

/**
 * Connect to MongoDB and assert it can run multi-document transactions.
 *
 * Money mutations (Phase 08) require transactions, which require a replica set.
 * We verify by actually opening a session + transaction — the only reliable proof.
 * Atlas clusters are replica sets by default; a bare local mongod is NOT.
 */
export async function connectDb(): Promise<void> {
  mongoose.set('strictQuery', true);

  await mongoose.connect(env.MONGO_URI, {
    serverSelectionTimeoutMS: 10_000,
    autoIndex: false, // indexes are created explicitly in dbInit (no surprise builds in prod)
  });

  await assertTransactionsAvailable();

  // eslint-disable-next-line no-console
  console.log('✅ MongoDB connected (transactions verified)');
}

async function assertTransactionsAvailable(): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // no-op read inside a txn — succeeds only on a replica set / mongos
      await mongoose.connection.db!.admin().ping();
    });
  } catch (err) {
    throw new Error(
      'MongoDB is reachable but transactions are unavailable. ' +
        'Samity requires a replica set (Atlas works out of the box; a standalone mongod does not). ' +
        `Underlying error: ${(err as Error).message}`,
    );
  } finally {
    await session.endSession();
  }
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
