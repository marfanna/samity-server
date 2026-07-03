import { env } from './config/env';
import { connectDb, disconnectDb } from './config/db';
import { dbInit } from './config/dbInit';
import { buildApp } from './app';
import { startReminders } from './shared/reminders';
import type { Server } from 'http';

let server: Server | undefined;

async function bootstrap(): Promise<void> {
  await connectDb();
  await dbInit();

  startReminders();
  const app = buildApp();
  server = app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`🚀 samity-server listening on :${env.PORT} (${env.NODE_ENV})`);
  });
}

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received — shutting down`);
  server?.close();
  await disconnectDb();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('❌ Boot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
