export type HealthReport = {
  status: 'ok' | 'error';
  database: 'up' | 'down';
  version: string;
};
