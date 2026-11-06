'use strict';
const fs = require('fs/promises');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const TABLES = ['feedback', 'players', 'daily_stats'];
const feedbackMem = [], playersMem = new Map(), dailyMem = new Map(), bootsMem = [];
let pool = null, status = 'fallback', serial = 0, warned = false;

function logError(action, err) {
  console.error('[db] ' + action + ' failed:', err && (err.code || err.message) || 'unknown error');
}
async function append(table, row) {
  try {
    await fs.mkdir(DATA, { recursive: true });
    await fs.appendFile(path.join(DATA, table + '.jsonl'), JSON.stringify(row) + '\n', 'utf8');
  } catch (err) { logError('JSONL ' + table, err); throw err; }
}
async function readLines(table) {
  try {
    const raw = await fs.readFile(path.join(DATA, table + '.jsonl'), 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code !== 'ENOENT') logError('Read JSONL ' + table, err);
    return [];
  }
}
function setFallback(reason) {
  status = 'fallback';
  if (pool) { pool.end().catch((err) => logError('Close Postgres pool', err)); pool = null; }
  if (reason) logError('Postgres unavailable; using JSONL', reason);
}
async function init() {
  if (!process.env.DATABASE_URL) {
    if (!warned) { console.warn('[db] DATABASE_URL is not set; using ./data JSONL fallback.'); warned = true; }
  } else {
    try {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 2500 });
      pool.on('error', (err) => setFallback(err));
      await pool.query(`
        CREATE TABLE IF NOT EXISTS feedback (
          id serial PRIMARY KEY, created_at timestamptz DEFAULT now(), client_id text, username text, game text,
          device text, rtt_ms int, ux int, responsiveness int, latency int, features int, speed int,
          entertainment int, voice text, comment text, app_version text
        );
        CREATE TABLE IF NOT EXISTS players (
          client_id text PRIMARY KEY, username text, first_seen timestamptz, last_seen timestamptz, games_played int DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS daily_stats (
          day date, game text, rooms_created int, rooms_started int, games_finished int,
          total_game_seconds bigint, peak_players int, PRIMARY KEY(day, game)
        );
        CREATE TABLE IF NOT EXISTS boots (
          id serial PRIMARY KEY, started_at timestamptz DEFAULT now(), version text
        );
        CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback(created_at);
        CREATE INDEX IF NOT EXISTS players_last_seen_idx ON players(last_seen);
      `);
      await pool.query('INSERT INTO boots (version) VALUES ($1)', [process.env.APP_VERSION || '1.0.0']);
      status = 'ok';
      return;
    } catch (err) { setFallback(err); }
  }
  const [feedback, players, boots] = await Promise.all([readLines('feedback'), readLines('players'), readLines('boots')]);
  feedback.forEach((row) => { feedbackMem.push(row); serial = Math.max(serial, Number(row.id) || 0); });
  players.forEach((row) => { if (row.client_id) playersMem.set(row.client_id, row); });
  bootsMem.push(...boots);
  const boot = { id: ++serial, started_at: new Date().toISOString(), version: process.env.APP_VERSION || '1.0.0' };
  bootsMem.push(boot); await append('boots', boot);
}
function active() { return status === 'ok' && pool; }
async function fallbackWrite(table, row) {
  if (table !== 'daily_stats') await append(table, row);
  if (table === 'feedback') feedbackMem.push(row);
  else if (table === 'players') playersMem.set(row.client_id, row);
  else if (table === 'daily_stats') {
    const key = row.day + ':' + row.game, prior = dailyMem.get(key);
    dailyMem.set(key, prior ? {
      ...prior, rooms_created: prior.rooms_created + row.rooms_created,
      rooms_started: prior.rooms_started + row.rooms_started, games_finished: prior.games_finished + row.games_finished,
      total_game_seconds: Number(prior.total_game_seconds) + Number(row.total_game_seconds),
      peak_players: Math.max(prior.peak_players, row.peak_players)
    } : row);
  }
}
async function queryOrFallback(action, fallback, run) {
  if (!active()) return fallback();
  try { return await run(); }
  catch (err) { setFallback(err); return fallback(); }
}
async function upsertPlayer(clientId, username) {
  const now = new Date().toISOString();
  return queryOrFallback('upsert player', async () => {
    const prior = playersMem.get(clientId);
    const row = { client_id: clientId, username, first_seen: prior ? prior.first_seen : now, last_seen: now, games_played: prior ? prior.games_played || 0 : 0 };
    await append('players', row);
    playersMem.set(clientId, row);
  }, async () => {
    await pool.query(`INSERT INTO players (client_id, username, first_seen, last_seen, games_played)
      VALUES ($1, $2, now(), now(), 0)
      ON CONFLICT (client_id) DO UPDATE SET username = EXCLUDED.username, last_seen = now()`, [clientId, username]);
  });
}
async function recordFeedback(data) {
  return queryOrFallback('insert feedback', async () => {
    const row = { ...data, id: ++serial, created_at: new Date().toISOString() };
    await fallbackWrite('feedback', row);
    return row;
  }, async () => {
    const fields = ['client_id','username','game','device','rtt_ms','ux','responsiveness','latency','features','speed','entertainment','voice','comment','app_version'];
    const values = fields.map((f) => data[f]);
    const result = await pool.query(`INSERT INTO feedback (${fields.join(',')}) VALUES (${fields.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id, created_at`, values);
    return { ...data, ...result.rows[0] };
  });
}
async function incrementGamesPlayed(clientIds) {
  const ids = Array.from(new Set(clientIds.filter(Boolean)));
  if (!ids.length) return;
  return queryOrFallback('increment games played', async () => {
    for (const id of ids) {
      const row = playersMem.get(id);
      if (row) {
        const updated = { ...row, games_played: (row.games_played || 0) + 1 };
        await append('players', updated); playersMem.set(id, updated);
      }
    }
  }, async () => {
    for (const id of ids) await pool.query('UPDATE players SET games_played = games_played + 1 WHERE client_id = $1', [id]);
  });
}
async function flushDaily(rows) {
  if (!rows.length) return true;
  return queryOrFallback('flush daily stats', async () => {
    for (const row of rows) await fallbackWrite('daily_stats', row);
    return true;
  }, async () => {
    for (const row of rows) await pool.query(`INSERT INTO daily_stats (day, game, rooms_created, rooms_started, games_finished, total_game_seconds, peak_players)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (day, game) DO UPDATE SET rooms_created=daily_stats.rooms_created+EXCLUDED.rooms_created,
      rooms_started=daily_stats.rooms_started+EXCLUDED.rooms_started, games_finished=daily_stats.games_finished+EXCLUDED.games_finished,
      total_game_seconds=daily_stats.total_game_seconds+EXCLUDED.total_game_seconds,
      peak_players=GREATEST(daily_stats.peak_players, EXCLUDED.peak_players)`,
    [row.day,row.game,row.rooms_created,row.rooms_started,row.games_finished,row.total_game_seconds,row.peak_players]);
    return true;
  });
}
function dateValue(value) { return value instanceof Date ? value.toISOString() : value; }
async function adminData(filters) {
  const fbFallback = () => feedbackMem.filter((x) => (!filters.game || x.game === filters.game) &&
    (!filters.from || String(x.created_at).slice(0, 10) >= filters.from) &&
    (!filters.to || String(x.created_at).slice(0, 10) <= filters.to));
  return queryOrFallback('load admin data', async () => {
    const fbs = fbFallback(), players = Array.from(playersMem.values()), daily = Array.from(dailyMem.values());
    const today = new Date().toISOString().slice(0, 10);
    const first = (p) => String(p.first_seen || '').slice(0, 10);
    const ratings = ['ux','responsiveness','latency','features','speed','entertainment'];
    const avg = {}; ratings.forEach((key) => { const values = fbs.map((x) => Number(x[key])).filter(Number.isFinite); avg[key] = values.length ? values.reduce((a,b)=>a+b,0)/values.length : null; });
    const rtts = fbs.map((x) => x.rtt_ms).filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x))).map(Number);
    const split = (key) => fbs.reduce((out, row) => { out[row[key]]=(out[row[key]]||0)+1; return out; }, {});
    return {
      dbStatus: status,       feedback: { count: fbs.length, averages: avg, averageRtt: rtts.length ? rtts.reduce((a,b)=>a+b,0)/rtts.length : null, voice: split('voice'), game: split('game'), device: split('device'),
        comments: fbs.filter((x)=>x.comment).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,50).map((x)=>({...x,created_at:dateValue(x.created_at)})) },
      players: { total: players.length, newToday: players.filter((p)=>first(p)===today).length, returning: players.filter((p)=>first(p)<today).length,
        top: players.slice().sort((a,b)=>(b.games_played||0)-(a.games_played||0)).slice(0,10), list: players.map((p)=>({...p,first_seen:dateValue(p.first_seen),last_seen:dateValue(p.last_seen)})) },
      daily: daily.filter((x)=>String(x.day)>=new Date(Date.now()-29*86400000).toISOString().slice(0,10))
    };
  }, async () => {
    const p = pool;
    const params = [], clauses = [];
    if (filters.game) { params.push(filters.game); clauses.push('game = $' + params.length); }
    if (filters.from) { params.push(filters.from); clauses.push('created_at::date >= $' + params.length); }
    if (filters.to) { params.push(filters.to); clauses.push('created_at::date <= $' + params.length); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const [f, players, daily] = await Promise.all([
      p.query('SELECT id, created_at, client_id, username, game, device, rtt_ms, ux, responsiveness, latency, features, speed, entertainment, voice, comment, app_version FROM feedback' + where + ' ORDER BY created_at DESC', params),
      p.query('SELECT client_id, username, first_seen, last_seen, games_played FROM players ORDER BY username'),
      p.query("SELECT day, game, rooms_created, rooms_started, games_finished, total_game_seconds, peak_players FROM daily_stats WHERE day >= current_date - interval '29 days' ORDER BY day, game")
    ]);
    const rows=f.rows, people=players.rows, ratings=['ux','responsiveness','latency','features','speed','entertainment'], averages={};
    ratings.forEach((key)=>{const vals=rows.map((x)=>Number(x[key])).filter(Number.isFinite);averages[key]=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null});
    const split=(key)=>rows.reduce((out,row)=>{out[row[key]]=(out[row[key]]||0)+1;return out},{});
    const rtts=rows.map((x)=>x.rtt_ms).filter((x)=>x!==null&&x!==undefined&&Number.isFinite(Number(x))).map(Number);
    const today=new Date().toISOString().slice(0,10), first=(x)=>String(x.first_seen).slice(0,10);
    return {dbStatus:status, feedback:{count:rows.length,averages,averageRtt:rtts.length?rtts.reduce((a,b)=>a+b,0)/rtts.length:null,voice:split('voice'),game:split('game'),device:split('device'),
      comments:rows.filter((x)=>x.comment).slice(0,50)},players:{total:people.length,newToday:people.filter((x)=>first(x)===today).length,
      returning:people.filter((x)=>first(x)<today).length,top:people.slice().sort((a,b)=>b.games_played-a.games_played).slice(0,10),list:people},
      daily:daily.rows.map((x)=>({...x,day:dateValue(x.day)}))};
  });
}
async function exportRows(table) {
  const fallback = () => table==='feedback'?feedbackMem:table==='players'?Array.from(playersMem.values()):Array.from(dailyMem.values());
  return queryOrFallback('export ' + table, fallback, async () => {
    const sql = {
      feedback:'SELECT id,created_at,client_id,username,game,device,rtt_ms,ux,responsiveness,latency,features,speed,entertainment,voice,comment,app_version FROM feedback ORDER BY created_at DESC',
      players:'SELECT client_id,username,first_seen,last_seen,games_played FROM players ORDER BY username',
      daily:'SELECT day,game,rooms_created,rooms_started,games_finished,total_game_seconds,peak_players FROM daily_stats ORDER BY day DESC,game'
    }[table];
    const result=await pool.query(sql);return result.rows;
  });
}
async function deletePlayer(clientId) {
  return queryOrFallback('delete player', async () => {
    playersMem.delete(clientId);
    for(let i=feedbackMem.length-1;i>=0;i--)if(feedbackMem[i].client_id===clientId)feedbackMem.splice(i,1);
    await fs.mkdir(DATA, { recursive: true });
    for (const table of ['players', 'feedback']) {
      try {
        const rows=(await readLines(table)).filter((row)=>row.client_id!==clientId);
        await fs.writeFile(path.join(DATA,table+'.jsonl'),rows.map((row)=>JSON.stringify(row)).join('\n')+(rows.length?'\n':''),'utf8');
      } catch(err) { logError('Delete JSONL ' + table,err); throw err; }
    }
    return true;
  }, async () => {
    await pool.query('DELETE FROM feedback WHERE client_id = $1',[clientId]);
    await pool.query('DELETE FROM players WHERE client_id = $1',[clientId]);
    return true;
  });
}
async function recentBoots() {
  return queryOrFallback('count recent boots', async () => bootsMem.filter((x)=>Date.now()-new Date(x.started_at).getTime()<7*86400000).length,
    async () => Number((await pool.query("SELECT count(*) AS n FROM boots WHERE started_at >= now() - interval '7 days'")).rows[0].n));
}
async function close() { if(pool)try{await pool.end()}catch(err){logError('close pool',err)} }
module.exports={init,upsertPlayer,recordFeedback,incrementGamesPlayed,flushDaily,adminData,exportRows,deletePlayer,recentBoots,get status(){return status},close};
