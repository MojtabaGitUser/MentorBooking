import { Injectable, Logger } from '@nestjs/common';
import { LifecycleService } from '../sessions/lifecycle.service';
import { RolloverService } from '../wallet/rollover.service';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import { ReminderService } from './reminder.service';
import { WORKER_DEFAULTS, type WorkerConfig } from './worker-config';

export interface TickReport {
  started: number;
  resolved: number;
  expiredLots: number;
  remindersQueued: number;
  delivered: number;
  suppressed: number;
  failed: number;
  jobErrors: string[];
}

// Orchestrates one worker tick. Every step is a database-coordinated, idempotent operation, so any
// number of worker processes may run ticks concurrently and a restarted worker simply catches up.
@Injectable()
export class WorkerService {
  private readonly logger = new Logger('Worker');
  private stopping = false;
  private wake: (() => void) | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly lifecycle: LifecycleService, private readonly rollover: RolloverService,
              private readonly reminders: ReminderService, private readonly outbox: OutboxDispatcher) {}

  // Order: start before resolve (a due start must not be skipped), expire before reminders, and queue
  // reminders before dispatch so a late booking's reminder goes out in the same tick.
  async tick(options: { now?: Date; batchSize?: number } = {}): Promise<TickReport> {
    const limit = options.batchSize ?? WORKER_DEFAULTS.batchSize;
    const now = options.now;
    const report: TickReport = { started: 0, resolved: 0, expiredLots: 0, remindersQueued: 0,
      delivered: 0, suppressed: 0, failed: 0, jobErrors: [] };
    const step = async (name: string, job: () => Promise<void>) => {
      // A failing job is logged and retried next tick; it never stops the other jobs.
      try { await job(); } catch (error) {
        report.jobErrors.push(name);
        this.logger.error(`Job ${name} failed; will retry next tick: ${(error as Error).message}`);
      }
    };
    await step('start', async () => { report.started = (await this.lifecycle.startDue({ now, limit })).started.length; });
    await step('resolve', async () => {
      const result = await this.lifecycle.resolveDue({ now, limit });
      report.resolved = result.resolved.length;
      report.failed += result.failed;
    });
    await step('expire', async () => { report.expiredLots = (await this.rollover.expireRolloverLots(now)).expiredLots; });
    await step('reminders', async () => { report.remindersQueued = (await this.reminders.queueDue({ now, limit })).queued; });
    await step('dispatch', async () => {
      const result = await this.outbox.dispatch({ now, limit });
      report.delivered = result.delivered;
      report.suppressed = result.suppressed;
      report.failed += result.failed;
    });
    const { jobErrors, ...counts } = report;
    if (Object.values(counts).some(n => n > 0) || jobErrors.length) {
      this.logger.log(`Tick: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}` +
        (jobErrors.length ? ` jobErrors=${jobErrors.join(',')}` : ''));
    }
    return report;
  }

  // Polls until stop(). The interval is measured from the end of a tick, so slow ticks never overlap.
  run(config: WorkerConfig) {
    this.stopping = false;
    this.logger.log(`Worker started: pollIntervalMs=${config.pollIntervalMs} batchSize=${config.batchSize}`);
    this.running = (async () => {
      while (!this.stopping) {
        await this.tick({ batchSize: config.batchSize });
        if (this.stopping) break;
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, config.pollIntervalMs);
          this.wake = () => { clearTimeout(timer); resolve(); };
        });
        this.wake = null;
      }
      this.logger.log('Worker stopped');
    })();
    return this.running;
  }

  // Graceful: lets the current tick finish (its transactions commit or roll back), then exits the loop.
  async stop() {
    this.stopping = true;
    this.wake?.();
    await this.running;
  }
}
