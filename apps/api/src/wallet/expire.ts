import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../api.module';
import { RolloverService } from './rollover.service';

async function expire() {
  const app = await NestFactory.createApplicationContext(ApiModule, { logger: false });
  try {
    console.log(JSON.stringify(await app.get(RolloverService).expireRolloverLots()));
  } finally {
    await app.close();
  }
}
void expire();
