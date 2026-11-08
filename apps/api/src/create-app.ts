import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { IncomingMessage } from 'node:http';
import { ApiModule } from './api.module';

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(ApiModule);
  // Register before Nest's JSON parser. Authenticate the bytes before decoding JSON.
  app.useBodyParser('raw', {
    type: (req: IncomingMessage) => /^\/webhooks\/fake-payments\/?(?:\?|$)/i.test(req.url ?? ''),
    inflate: false, limit: '32kb',
  });
  return app;
}
