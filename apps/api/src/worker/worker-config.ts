export interface WorkerConfig {
  pollIntervalMs: number;
  batchSize: number;
}

export const WORKER_DEFAULTS: WorkerConfig = { pollIntervalMs: 5000, batchSize: 100 };
const BOUNDS = { pollIntervalMs: [250, 3_600_000], batchSize: [1, 1000] } as const;
const NAMES = { pollIntervalMs: 'WORKER_POLL_INTERVAL_MS', batchSize: 'WORKER_BATCH_SIZE' } as const;

// Fail fast: a worker with a nonsensical interval or batch would spin or stall silently.
export function workerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const config = { ...WORKER_DEFAULTS };
  for (const key of Object.keys(NAMES) as (keyof WorkerConfig)[]) {
    const raw = env[NAMES[key]];
    if (raw === undefined || raw === '') continue;
    const [min, max] = BOUNDS[key];
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
      throw new Error(`${NAMES[key]} must be an integer from ${min} to ${max}; got "${raw}".`);
    }
    config[key] = Number(raw);
  }
  return config;
}
