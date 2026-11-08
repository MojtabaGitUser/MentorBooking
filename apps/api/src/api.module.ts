import { Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Pool } from 'pg';
import { connectionOptions } from '../../../infra/db/config.cjs';
import { HealthController } from './health.controller';

import { DemoAuthGuard } from './auth/demo-auth.guard';
import { MeController } from './me.controller';

import { LedgerService } from './wallet/ledger.service';
import { WalletService } from './wallet/wallet.service';
import { WalletController } from './wallet/wallet.controller';

import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';

import { RolloverService } from './wallet/rollover.service';

import { ScheduleController } from './mentor/schedule.controller';
import { ScheduleService } from './mentor/schedule.service';

import { SlotsController } from './mentor/slots.controller';
import { SlotsService } from './mentor/slots.service';

import { BookingController } from './sessions/booking.controller';
import { BookingService } from './sessions/booking.service';
import { CancellationController } from './sessions/cancellation.controller';
import { CancellationService } from './sessions/cancellation.service';

@Module({
  controllers: [CancellationController, BookingController, SlotsController, ScheduleController, HealthController, MeController, WalletController, PaymentsController],
  providers: [CancellationService, BookingService, SlotsService, ScheduleService, RolloverService, PaymentsService, LedgerService, WalletService, { provide: APP_GUARD, useClass: DemoAuthGuard }, {
    provide: Pool,
    useFactory: () => new Pool({
      ...connectionOptions(),
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
    }).on('error', (error: Error) => console.error('PostgreSQL pool error', error.message)),
  }],
})
export class ApiModule implements OnApplicationShutdown {
  constructor(private readonly pool: Pool) {}
  async onApplicationShutdown() { await this.pool.end(); }
}
