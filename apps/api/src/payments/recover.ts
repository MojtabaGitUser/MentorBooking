import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../api.module';
import { PaymentsService } from './payments.service';

async function recover() {
  const app = await NestFactory.createApplicationContext(ApiModule, { logger: false });
  try {
    const result = await app.get(PaymentsService).recoverPending();
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
  } finally {
    await app.close();
  }
}
void recover();
