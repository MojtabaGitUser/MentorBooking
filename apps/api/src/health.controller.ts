import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import type { HealthReport } from '@mentor/shared';
import { version } from '../package.json';

@Controller()
export class HealthController {
  constructor(@Inject(Pool) private readonly pool: Pool) {}

  @Get('health')
  async health(): Promise<HealthReport> {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok', database: 'up', version };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'down', version });
    }
  }
}
