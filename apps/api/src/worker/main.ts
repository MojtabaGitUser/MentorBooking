import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../api.module';
import { workerConfig } from './worker-config';
import { WorkerService } from './worker.service';

// Dedicated worker process (Compose service "worker"). The API process never starts this loop.
// `--once` runs a single tick and prints its report, for demos and manual catch-up.
async function main() {
  let config;
  try {
    config = workerConfig();
  } catch (error) {
    console.error(`Invalid worker configuration: ${(error as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const app = await NestFactory.createApplicationContext(ApiModule);
  const worker = app.get(WorkerService);
  if (process.argv.includes('--once')) {
    try {
      console.log(JSON.stringify(await worker.tick({ batchSize: config.batchSize })));
    } finally { await app.close(); }
    return;
  }
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; finishing the current tick`);
    await worker.stop();
    await app.close();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  await worker.run(config);
}

void main().catch(error => {
  console.error('Worker crashed:', (error as Error).message);
  process.exit(1);
});
