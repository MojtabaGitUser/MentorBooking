import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const directory = process.argv.includes('--directory');
const db = 'booking_ui_' + randomUUID().replaceAll('-', '');
const api = db + '-api',
  web = db + '-web';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const compose = (...args) => docker('compose', ...args);
const start = (name, port, env, service) =>
  compose('run', '--rm', '-d', '--no-deps', '--name', name, '-p', `127.0.0.1::${port}`, ...env, service);
const url = (name, port) => 'http://' + docker('port', name, String(port) + '/tcp');
let outageStarted = false,
  created = false,
  apiStarted = false,
  webStarted = false;
try {
  compose('exec', '-T', 'db', 'createdb', '-U', 'mentor', db);
  created = true;
  const env = ['-e', 'PGDATABASE=' + db, '-e', 'DATABASE_URL=', '-e', 'EXTERNAL_API_CONFIGURED='];
  for (const command of ['migrate', 'seed'])
    compose('run', '--rm', '--no-deps', ...env, 'migrate', 'node', 'infra/db/bootstrap.mjs', command);
  start(api, 3001, [...env, '-e', 'DEMO_AUTH_ENABLED=true'], 'api');
  apiStarted = true;
  start(web, 3000, ['-e', 'API_BASE_URL=http://' + api + ':3001'], 'web');
  webStarted = true;
  const baseURL = url(web, 3000),
    apiURL = url(api, 3001);
  for (let i = 0; i < 60; i++) {
    if (
      await fetch(baseURL)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await delay(500);
  }
  let outageURL;
  if (directory) {
    start(web + '-outage', 3000, ['-e', 'API_BASE_URL=http://127.0.0.1:9'], 'web');
    outageStarted = true;
    outageURL = url(web + '-outage', 3000);
  }
  const run = spawnSync(
    process.execPath,
    [
      'node_modules/@playwright/test/cli.js',
      'test',
      ...process.argv.slice(2).filter((arg) => arg !== '--directory'),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        E2E_BOOKING_DB: directory ? '' : db,
        E2E_API_DOWN_URL: outageURL,
        E2E_BASE_URL: baseURL,
        E2E_BOOKING_API: apiURL,
      },
    },
  );
  process.exitCode = run.status ?? 1;
} finally {
  if (outageStarted) docker('stop', web + '-outage');
  if (webStarted) docker('stop', web);
  if (apiStarted) docker('stop', api);
  if (created) compose('exec', '-T', 'db', 'dropdb', '-U', 'mentor', db);
}
