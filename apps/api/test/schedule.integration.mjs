import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { createApp } from '../dist/create-app.js';
import { connectionOptions } from '../../../infra/db/config.cjs';

const database = 'schedule_test_' + randomUUID().replaceAll('-', '');
const owner = new pg.Client({ ...connectionOptions(), database:'postgres' });
const [mentor, other, mentee, admin] = ['01','02','03','05'].map(n => '00000000-0000-4000-8000-0000000000'+n);
const weekly = '/mentor/availability';
const blocks = '/mentor/blockouts';
const rule = { weekday:1, startLocal:'09:00', endLocal:'12:00' };
const block = { startsAt:'2030-10-26T23:30:00+01:00', endsAt:'2030-10-28T00:00:00Z', reason:'Away' };
let app, base, pool, created;

before(async () => {
  assert.ok(!process.env.DATABASE_URL);
  await owner.connect();
  await owner.query('CREATE DATABASE '+database);
  created = true;
  process.env.PGDATABASE = database;
  execFileSync(process.execPath, ['infra/db/bootstrap.mjs','migrate']);
  process.env.PGUSER = 'mentor_app';
  process.env.DB_PASSWORD_FILE = process.env.RUNTIME_PASSWORD_FILE;
  process.env.DEMO_AUTH_ENABLED = 'true';
  execFileSync(process.execPath, ['infra/db/bootstrap.mjs','seed']);
  app = await createApp();
  await app.listen(0,'127.0.0.1');
  base = await app.getUrl();
  pool = app.get(pg.Pool);
});
after(async () => {
  try {
    await app?.close();
    if (created) await owner.query('DROP DATABASE '+database);
  } finally { await owner.end(); }
});

async function request(method, path, body, user = mentor) {
  const response = await fetch(base+path, { method, body:JSON.stringify(body),
    headers:{'Content-Type':'application/json', ...(user && {'X-User-Id':user})} });
  return {status:response.status, data:response.status === 204 ? null : await response.json()};
}

test('weekly CRUD preserves wall times, current mentor zone, ordering and ownership', async () => {
  const {status,data} = await request('POST',weekly,rule);
  assert.equal(status,201);
  assert.deepEqual(data,{...rule,id:data.id,mentorId:mentor,isActive:true,timezone:'Europe/London'});
  const path = weekly+'/'+data.id;
  assert.equal((await request('PATCH',path,{weekday:2},other)).status,403);
  assert.equal((await request('DELETE',path,undefined,other)).status,403);
  assert.deepEqual((await request('GET',weekly,undefined,other)).data,[]);
  await pool.query("UPDATE users SET timezone='Asia/Kolkata' WHERE id=$1",[mentor]);
  assert.deepEqual((await request('GET',weekly)).data,[{...data,timezone:'Asia/Kolkata'}]);
  await pool.query("UPDATE users SET timezone='Europe/London' WHERE id=$1",[mentor]);
  for (const startLocal of ['12:00','13:00']) assert.equal((await request('PATCH',path,{startLocal})).status,422);
  const adjacent = await request('POST',weekly,{...rule,startLocal:'12:00',endLocal:'14:00'});
  assert.equal(adjacent.status,201);
  assert.equal((await request('PATCH',path,{endLocal:'12:01'})).status,422);
  assert.deepEqual((await request('GET',weekly)).data,[data,adjacent.data]);
  const edited = await request('PATCH',path,{weekday:3});
  assert.deepEqual(edited,{status:200,data:{...data,weekday:3}});
  for (const id of [adjacent.data.id,data.id]) assert.equal((await request('DELETE',weekly+'/'+id)).status,204);
  assert.equal((await request('PATCH',path,{weekday:4})).status,404);
});

test('parallel intersecting rules commit once; distinct weekdays and mentors are independent', async () => {
  const results = await Promise.all([request('POST',weekly,rule),request('POST',weekly,rule)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,422]);
  assert.equal((await request('POST',weekly,{...rule,weekday:2})).status,201);
  assert.equal((await request('POST',weekly,{...rule,weekday:4},other)).status,201);
});

test('blockout CRUD accepts overlapping exclusions and absolute instants across DST and midnight', async () => {
  const {status,data} = await request('POST',blocks,block);
  assert.equal(status,201);
  assert.equal(data.startsAt,'2030-10-26T22:30:00.000000Z');
  assert.equal(data.endsAt,'2030-10-28T00:00:00.000000Z');
  const path = blocks+'/'+data.id;
  assert.equal((await request('POST',blocks,block)).status,201);
  assert.deepEqual((await request('GET',blocks,undefined,other)).data,[]);
  assert.equal((await request('PATCH',path,{reason:null},other)).status,403);
  assert.equal((await request('DELETE',path,undefined,other)).status,403);
  for (const startsAt of [block.endsAt,'2031-01-01T00:00Z','2030-02-30T00:00Z','2030-01-01T00:00']) {
    assert.equal((await request('PATCH',path,{startsAt})).status,422);
  }
  assert.deepEqual((await request('GET',blocks)).data.find(b=>b.id===data.id),data);
  const edited = await request('PATCH',path,{startsAt:'2030-01-01T00:00:00.000001Z',endsAt:'2030-01-01T00:00:00.000002Z',reason:null});
  assert.equal(edited.status,200);
  assert.equal(edited.data.id,data.id);
  assert.equal(edited.data.reason,null);
  assert.equal(edited.data.endsAt,'2030-01-01T00:00:00.000002Z');
  assert.deepEqual((await request('GET',blocks)).data[0],edited.data);
  assert.equal((await request('DELETE',path)).status,204);
  assert.equal((await request('DELETE',path)).status,404);
});

test('both collections enforce auth and reject spoofed ownership', async () => {
  for (const [path,body] of [[weekly,rule],[blocks,block]]) {
    for (const [method,url] of [['POST',path],['PATCH',path+'/'+randomUUID()],['DELETE',path+'/'+randomUUID()]]) {
      for (const user of [null,'broken',mentee,admin]) {
        assert.equal((await request(method,url,method==='DELETE'?undefined:body,user)).status,
          user===mentee || user===admin ? 403 : 401);
      }
    }
    assert.equal((await request('POST',path,{...body,mentorId:other})).status,422);
  }
});

test('blockout edit waits for booking lock, reports committed session and preserves original interval', async () => {
  const start = '2032-01-05T10:00:00Z';
  const end = '2032-01-05T10:30:00Z';
  const adjacent = await request('POST',blocks,{startsAt:'2032-01-05T09:00Z',endsAt:start});
  assert.equal(adjacent.status,201);
  const path = blocks+'/'+adjacent.data.id;
  const booking = await pool.connect();
  let edit, session;
  try {
    await booking.query('BEGIN');
    await booking.query('SELECT mentor_id FROM mentor_profiles WHERE mentor_id=$1 FOR UPDATE',[mentor]);
    ({rows:[session]} = await booking.query(`INSERT INTO sessions (mentor_id,mentee_id,starts_at,ends_at)
      VALUES ($1,$2,$3,$4) RETURNING id`,[mentor,mentee,start,end]));
    edit = request('PATCH',path,{endsAt:end});
    const deadline = Date.now()+1500;
    let waiting;
    do {
      ({rows:[waiting]} = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE
        pg_backend_pid() <> pid AND pg_blocking_pids(pid) @> ARRAY[$1::int]`,[booking.processID]));
    } while (!waiting && Date.now()<deadline);
    assert.ok(waiting,'edit waited for mentor row');
    await booking.query('COMMIT');
  } finally { await booking.query('ROLLBACK'); booking.release(); }
  const result = await edit;
  assert.equal(result.status,409);
  assert.deepEqual(result.data.sessionIds,[session.id]);
  assert.deepEqual((await request('GET',blocks)).data.find(b=>b.id===adjacent.data.id),adjacent.data);
  assert.equal((await request('POST',blocks,{startsAt:start,endsAt:end})).status,409);
  assert.equal((await request('PATCH',path,{endsAt:start})).status,200);
  await pool.query("UPDATE sessions SET status='cancelled', cancelled_at=now(), cancellation_actor=$1 WHERE id=$2",[mentor,session.id]);
  assert.equal((await request('PATCH',path,{endsAt:end})).status,200);
});

test('09:00–12:00 rule includes six half-hours; a 10:00–11:00 exclusion covers exactly two', async () => {
  const user = other;
  const createdRule = await request('POST',weekly,rule,user);
  assert.equal(createdRule.status,201);
  const monday = createdRule.data;
  assert.equal(monday.timezone,'Asia/Kolkata');
  const result = await request('POST',blocks,{startsAt:'2030-01-07T10:00+05:30',endsAt:'2030-01-07T11:00+05:30'},user);
  assert.equal(result.status,201);
  const windows = ['09:00','09:30','10:00','10:30','11:00','11:30','12:00']
    .filter(time=>time>=monday.startLocal && time<monday.endLocal);
  assert.equal(windows.length,6);
  const [exclusion] = (await request('GET',blocks,undefined,user)).data;
  assert.deepEqual(windows.filter(time=>{
    const instant = Date.parse('2030-01-07T'+time+':00+05:30');
    return instant<Date.parse(exclusion.startsAt) || instant>=Date.parse(exclusion.endsAt);
  }),['09:00','09:30','11:00','11:30']);
});

test('slot preview filters persisted microsecond exclusions and sessions in a read-only snapshot', async () => {
  const id = randomUUID();
  await pool.query("INSERT INTO users (id,role,display_name,timezone) VALUES ($1,'mentor','Slot fixture','Asia/Kolkata')",[id]);
  await pool.query('INSERT INTO mentor_profiles (mentor_id) VALUES ($1)',[id]);
  const date = '2099-01-05';
  const weekday = new Date(date+'T00:00:00Z').getUTCDay() || 7;
  const path = '/mentors/'+id+'/slots?from='+date+'&to='+date;
  const preview = async () => {
    const response = await request('GET',path,undefined,mentee);
    assert.equal(response.status,200,JSON.stringify(response.data));
    return response.data;
  };
  assert.deepEqual((await preview()).slots,[]);
  assert.equal((await request('POST',weekly,{weekday,startLocal:'09:01',endLocal:'13:10'},id)).status,201);
  await pool.query("INSERT INTO weekly_availability (mentor_id,weekday,start_local,end_local,is_active) VALUES ($1,$2,'14:00','15:00',false)",[id,weekday]);
  const initial = await preview();
  assert.equal(initial.viewerTimezone,'America/Vancouver');
  assert.equal(initial.mentorTimezone,'Asia/Kolkata');
  assert.equal(initial.slots.length,7);
  assert.equal(initial.slots[0].localStartsAt.slice(0,10),'2099-01-04');
  assert.equal(Date.parse(initial.slots[0].localStartsAt),Date.parse('2099-01-05T04:00:00Z'));
  // Midnight-spanning exclusion ends exactly at 10:00; a one-microsecond overlap blocks 10:30.
  for (const [startsAt,endsAt] of [
    ['2099-01-04T23:00+05:30','2099-01-05T10:00+05:30'],
    ['2099-01-05T10:59:59.999999+05:30','2099-01-05T11:00+05:30'],
  ]) assert.equal((await request('POST',blocks,{startsAt,endsAt},id)).status,201);
  const { rows:[session] } = await pool.query(`INSERT INTO sessions (mentor_id,mentee_id,starts_at,ends_at)
    VALUES ($1,$2,'2099-01-05T11:15+05:30','2099-01-05T11:45+05:30') RETURNING id`,[id,mentee]);
  async function snapshot() {
    const values = [];
    for (const table of ['weekly_availability','availability_blockouts','sessions']) {
      values.push((await pool.query('SELECT to_jsonb(t) AS record FROM '+table+' t WHERE mentor_id=$1 ORDER BY id',[id])).rows);
    }
    return values;
  }
  const before = await snapshot();
  const filtered = await preview();
  assert.deepEqual(filtered.slots.map(s=>s.startsAt),['2099-01-05T04:30:00Z','2099-01-05T06:30:00Z','2099-01-05T07:00:00Z']);
  const override = await request('GET',path+'&timezone=Asia/Kolkata',undefined,mentee);
  assert.equal(override.data.slots[0].localStartsAt,'2099-01-05T10:00:00+05:30');
  assert.deepEqual(await snapshot(),before);
  await pool.query("UPDATE sessions SET status='cancelled',cancelled_at=now(),cancellation_actor=$1 WHERE id=$2",[id,session.id]);
  assert.equal((await preview()).slots.length,5);
  const pastDay = '2000-01-03';
  assert.equal(new Date(pastDay+'T00:00:00Z').getUTCDay(),weekday);
  const past = await request('GET','/mentors/'+id+'/slots?from='+pastDay+'&to='+pastDay,undefined,mentee);
  assert.deepEqual(past.data.slots,[]);
});

test('slot endpoint enforces mentee access and validates mentor, range and viewer zone', async () => {
  const path = '/mentors/'+mentor+'/slots';
  const query = '?from=2099-01-05&to=2099-01-05';
  for (const [user,status] of [[null,401],[mentor,403],[admin,403]]) {
    assert.equal((await request('GET',path+query,undefined,user)).status,status);
  }
  for (const bad of [randomUUID(),mentee,'invalid']) {
    assert.equal((await request('GET','/mentors/'+bad+'/slots'+query,undefined,mentee)).status,404);
  }
  for (const bad of ['',query+'&timezone=Mars/Olympus',query+'&from=2099-01-05','?from=2099-01-06&to=2099-01-05']) {
    assert.equal((await request('GET',path+bad,undefined,mentee)).status,422);
  }
});
