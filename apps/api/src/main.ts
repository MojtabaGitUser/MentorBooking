import 'reflect-metadata';
import { createApp } from './create-app';

async function start() {
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}

void start();
