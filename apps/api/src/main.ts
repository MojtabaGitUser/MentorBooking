import 'reflect-metadata';
import { Module, OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { connectionOptions } from '../../../infra/db/config.cjs';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [{
    provide: Pool,
    useFactory: () => new Pool({
      ...connectionOptions(),
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
    }).on('error', (error: Error) => console.error('PostgreSQL pool error', error.message)),
  }],
})
class ApiModule implements OnApplicationShutdown {
  constructor(private readonly pool: Pool) {}
  async onApplicationShutdown() { await this.pool.end(); }
}

async function start() {
  const app = await NestFactory.create(ApiModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}

void start();
