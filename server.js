'use strict';
// Naija Whot: authoritative game server. Serves the page and runs rooms over WebSockets.
const http = require('http'), fs = require('fs'), path = require('path');
const crypto = require('crypto'), db = require('./db'), createAdminRouter = require('./admin');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const APP_VERSION = process.env.APP_VERSION || '1.0.0';
let adminRoute;
const T = process.env.FAST ? 0.05 : 1;            // FAST=1 shortens delays (testing only)
const D = (ms) => Math.round(ms * T);
const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : fallback;
};
const TURN_MS = envInt('TURN_MS', 30000), MAX_MISSED = envInt('MAX_MISSED', 1);

const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.svg': 'image/svg+xml' };
function soundList() {                               // every folder in public/sounds is a pack
  const dir = path.join(PUB, 'sounds'), packs = [];
  try {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (!e.isDirectory() || !/^[a-z0-9_-]+$/i.test(e.name)) return;
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'pack.json'), 'utf8')); } catch (x) {}
      const clips = fs.readdirSync(path.join(dir, e.name)).filter((f) => /^[a-z0-9_.-]+\.(wav|mp3|ogg)$/i.test(f)).sort()
        .map((f) => ({ id: e.name + '/' + f, n: f.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') }));
      if (clips.length) packs.push({ id: e.name, title: meta.title || e.name, explicit: !!meta.explicit, clips });
    });
  } catch (x) {}
  return { packs };
}
const server = http.createServer((req, res) => {
  let u; try { u = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (u.startsWith('/admin')) return adminRoute(req, res, u).catch((err) => { recordError('admin request', err); if (!res.headersSent) { adminHeaders(res); res.writeHead(500); } res.end('Request failed'); });
  if (u === '/healthz') return res.end('ok');
  if (u === '/api/sounds') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(JSON.stringify(soundList())); }
  const f = u === '/' ? '/index.html' : u === '/whot' ? '/whot.html' : u === '/ludo' ? '/ludo.html' : u;
  const full = path.normalize(path.join(PUB, f));
  if (!full.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { if (err.code !== 'ENOENT') recordError('static file read', err); res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': f.startsWith('/sounds/') ? 'public, max-age=86400' : 'no-cache' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 2048 });
const statBuckets = new Map(), pendingStats = new Map(), chatMinute = [], errors = [], errorTimes = [], adminFailures = new Map(), feedbackLimits = new Map();
const clientRtts = new Map();
const serverStartedAt = Date.now();
let activeNotice = null, lastLoopCheck = Date.now(), eventLoopLag = 0, flushingStats = null;
function dayKey(at) { return new Date(at || Date.now()).toISOString().slice(0, 10); }
function statBucket(map, day, game) {
  const key = day + ':' + game;
  if (!map.has(key)) map.set(key, { day, game, rooms_created: 0, rooms_started: 0, games_finished: 0, total_game_seconds: 0, peak_players: 0 });
  return map.get(key);
}
function statChange(game, key, amount) {
  const day = dayKey(), current = statBucket(statBuckets, day, game), pending = statBucket(pendingStats, day, game);
  current[key] += amount; pending[key] += amount;
}
function roomStarted(rm) {
  if (rm.started) return;
  rm.started = true;
  statChange(rm.game, 'rooms_started', 1);
}
function recordPeak(game, count) {
  const day = dayKey(), current = statBucket(statBuckets, day, game), pending = statBucket(pendingStats, day, game);
  if (count > current.peak_players) current.peak_players = count;
  if (count > pending.peak_players) pending.peak_players = count;
}
function recordError(action, err) {
  const now = Date.now();
  const item = { ts: new Date().toISOString(), message: String(err && (err.code || err.message) || err || action).replace(/[\u0000-\u001f]/g, ' ').slice(0, 160) };
  errors.push(item); if (errors.length > 20) errors.shift();
  errorTimes.push(now); while (errorTimes.length && now - errorTimes[0] > 3600000) errorTimes.shift();
  console.error('[server] ' + action + ': ' + item.message);
}
function trackChat() { const now = Date.now(); chatMinute.push(now); while (chatMinute.length && now - chatMinute[0] > 60000) chatMinute.shift(); }
function samplePeaks() {
  const counts = { whot: 0, ludo: 0 };
  for (const rm of rooms.values()) counts[rm.game] += rm.players.filter((p) => p.ws && p.ws.readyState === 1).length;
  Object.keys(counts).forEach((game) => recordPeak(game, counts[game]));
}
setInterval(() => { const now = Date.now(); eventLoopLag = Math.max(0, now - lastLoopCheck - 1000); lastLoopCheck = now; }, 1000);

/* ---------- cards ---------- */
const SH = ['circle', 'triangle', 'cross', 'square', 'star'];
const SET = {
  circle: [1,2,3,4,5,7,8,10,11,12,13,14], triangle: [1,2,3,4,5,7,8,10,11,12,13,14],
  cross: [1,2,3,5,7,10,11,13,14], square: [1,2,3,5,7,10,11,13,14], star: [1,2,3,4,5,7,8]
};
const enc = (c) => (c.s === 'whot' ? 520 : SH.indexOf(c.s) * 100 + c.n);
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const top = (G) => G.pile[G.pile.length - 1];
const nxt = (G, i, k) => (i + (k || 1)) % G.seats.length;
function legal(G, c) { const t = top(G); if (G.pending > 0) return c.n === t.n; return c.n === 20 || c.s === G.shape || c.n === t.n; }
function draw(G, si, k) {
  for (let i = 0; i < k; i++) {
    if (!G.market.length) { const t = G.pile.pop(); G.market = shuffle(G.pile); G.pile = [t]; }
    if (!G.market.length) break;
    G.hands[si].push(G.market.pop());
  }
}

/* ---------- rooms ---------- */
const rooms = new Map();
const AL = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CHAT_WORD_FILTER = [];
const CHAT_REACTIONS = ['👍', '❤️', '😂', '😮', '👏'];
const rid = () => Math.random().toString(36).slice(2, 10);
const clean = (n) => String(n || '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, 12) || 'Player';
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function mkRoom(game) {
  let code; do { code = Array.from({ length: 4 }, () => AL[Math.floor(Math.random() * AL.length)]).join(''); } while (rooms.has(code));
  const rm = { code, game, dice: 1, players: [], bots: 0, G: null, idle: 0, chat: [], createdAt: Date.now(), started: false }; rooms.set(code, rm);
  statChange(game, 'rooms_created', 1); samplePeaks(); return rm;
}
const live = (rm) => rm.players.filter((p) => !p.gone);
const host = (rm) => live(rm)[0];
function lobby(rm) {
  const hs = host(rm), L = live(rm), list = L.map((p) => ({ n: p.name, h: p === hs }));
  L.forEach((p, i) => send(p.ws, { t: 'lobby', game: rm.game, dice: rm.dice, code: rm.code, list, bots: rm.bots, host: p === hs, me: i }));
}
function addPlayer(rm, ws, name) {
  const p = { pid: rid() + rid(), name: clean(name), cid: ws.clientId || null, ws, gone: false, timer: null, chatAt: 0, chatTimes: [] };
  rm.players.push(p); ws.pid = p.pid; ws.code = rm.code;
  send(ws, { t: 'joined', game: rm.game, code: rm.code, pid: p.pid }); lobby(rm);
  send(ws, { t: 'chatlog', list: rm.chat });
  if (activeNotice && activeNotice.until > Date.now()) send(ws, { t: 'notice', text: activeNotice.text });
  samplePeaks(); return p;
}
function chat(rm, p, m) {
  const isReaction = m.reaction === true;
  if (isReaction && !CHAT_REACTIONS.includes(m.text)) return send(p.ws, { t: 'err', msg: 'Invalid reaction.' });
  if (!isReaction && typeof m.text !== 'string') return send(p.ws, { t: 'err', msg: 'Message must be 1 to 140 characters.' });
  const text = isReaction ? m.text : m.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  const length = Array.from(text).length;
  if (length < 1 || length > (isReaction ? 2 : 140)) return send(p.ws, { t: 'err', msg: 'Message must be 1 to 140 characters.' });
  const now = Date.now();
  p.chatTimes = p.chatTimes.filter((at) => now - at < 10000);
  if ((p.chatAt && now - p.chatAt < 600) || p.chatTimes.length >= 5) return send(p.ws, { t: 'err', msg: 'Slow down' });
  p.chatAt = now; p.chatTimes.push(now);
  const gameSeat = rm.G ? rm.G.seats.findIndex((s) => s.pid === p.pid) : -1;
  const seat = gameSeat >= 0 ? gameSeat : live(rm).findIndex((x) => x === p);
  const msg = { t: 'chat', from: p.name, seat, text, ts: now, reaction: isReaction };
  rm.chat.push(msg); if (rm.chat.length > 50) rm.chat.shift();
  trackChat();
  rm.players.forEach((x) => { if (x.ws) send(x.ws, msg); });
}
function gameFinished(rm, G) {
  if (!G.over || G.finishedCounted) return;
  G.finishedCounted = true;
  statChange(rm.game, 'games_finished', 1);
  statChange(rm.game, 'total_game_seconds', Math.max(0, Math.round((Date.now() - G.startedAt) / 1000)));
  const cids = G.seats.map((s) => s.clientId).filter(Boolean);
  db.incrementGamesPlayed(cids).catch((err) => recordError('update player game totals', err));
}
function drop(rm, p) {
  clearTimeout(p.timer); p.ws = null;
  const G = rm.G;
  if (G && !G.over) {
    const i = G.seats.findIndex((s) => s.pid === p.pid);
    if (i > -1 && !G.seats[i].bot) {
      p.gone = true; G.seats[i].bot = true; G.seats[i].name += ' (bot)';
      gpub(rm, { t: 'info', d: 0 }, G.seats[i].name + ' left. A computer takes over.');
    }
  } else rm.players = rm.players.filter((x) => x !== p);
  if (!rm.players.length) { if (rm.G) { clearTimeout(rm.G.botT); clearTurnTimer(rm.G); } rooms.delete(rm.code); return; }
  lobby(rm);
}
function clearTurnTimer(G) { clearTimeout(G.turnT); G.turnT = null; G.turnDeadline = null; }
function turnLeft(G) { return G.turnDeadline === null ? null : Math.max(0, G.turnDeadline - Date.now()); }
function armTurnTimer(rm, G, delay) {
  clearTurnTimer(G);
  if (G.over || !G.seats[G.turn] || G.seats[G.turn].bot) return;
  const p = rm.players.find((x) => x.pid === G.seats[G.turn].pid);
  if (!p || p.gone || !p.ws || p.ws.readyState !== 1) return;
  const wait = Math.max(0, Number(delay) || 0);
  G.turnDeadline = Date.now() + wait + TURN_MS;
  G.turnT = setTimeout(() => expireTurn(rm, G), wait + TURN_MS);
}
function expireTurn(rm, G) {
  if (rm.G !== G || G.over) return;
  G.turnT = null; G.turnDeadline = null;
  const si = G.turn, seat = G.seats[si];
  if (!seat || seat.bot) return;
  const p = rm.players.find((x) => x.pid === seat.pid);
  if (!p || p.gone || !p.ws || p.ws.readyState !== 1) return;
  seat.missed = (seat.missed || 0) + 1;
  if (seat.missed >= MAX_MISSED) {
    const name = seat.name, ws = p.ws;
    clearTimeout(p.timer);
    send(ws, { t: 'kicked', reason: 'idle' });
    p.ws = null; rm.players = rm.players.filter((x) => x !== p);
    if (ws.pid === p.pid) { ws.pid = null; ws.code = null; }
    seat.bot = true; seat.name += ' (bot)';
    gpub(rm, { t: 'info', d: 0 }, name + ' was removed for being inactive. A computer takes over.');
    if (rm.game === 'ludo') lBotAct(rm, G); else botMove(rm, G);
  } else if (rm.game === 'ludo') {
    if (G.phase === 'roll') lRoll(rm, G, si);
    else if (G.phase === 'pick' && G.opts.length) { const o = G.opts[0]; lMove(rm, G, si, o.k, o.d); }
  } else drawAct(rm, si);
}

/* ---------- game engine ---------- */
function whotStart(rm) {
  const hum = live(rm).slice(0, 4 - rm.bots), old = rm.G ? rm.G.seats : [];
  const seats = hum.map((p) => ({ pid: p.pid, clientId: p.cid, name: p.name, bot: false, w: 0, missed: 0 }));
  for (let k = 1; k <= rm.bots; k++) seats.push({ pid: 'bot' + k, name: 'Computer ' + k, bot: true, w: 0, missed: 0 });
  if (seats.length < 2) return;
  seats.forEach((s) => { const o = old.find((x) => x.pid === s.pid); if (o) s.w = o.w; });
  if (rm.G) { clearTimeout(rm.G.botT); clearTurnTimer(rm.G); }
  const d = []; SH.forEach((s) => SET[s].forEach((n) => d.push({ s, n })));
  for (let i = 0; i < 5; i++) d.push({ s: 'whot', n: 20 });
  shuffle(d);
  const G = rm.G = { seats, market: d, pile: [], hands: seats.map(() => []), turn: 0, pending: 0, shape: null, over: false, win: -1, seq: old.length ? rm.G.seq : 0, readyAt: 0, botT: null, turnT: null, turnDeadline: null, startedAt: Date.now() };
  roomStarted(rm); samplePeaks();
  const per = seats.length === 2 ? 6 : 5;
  for (let k = 0; k < per; k++) seats.forEach((s, j) => G.hands[j].push(G.market.pop()));
  let t; do { t = G.market.pop(); if ([1,2,5,8,14,20].includes(t.n)) { G.market.unshift(t); t = null; } } while (!t);
  t.rot = 0; G.pile.push(t); G.shape = t.s;
  publish(rm, { t: 'start', d: D(1200) }, 'New game. ' + seats[0].name + ' goes first.');
}
function publish(rm, last, msg) {
  const G = rm.G; clearTimeout(G.botT); clearTurnTimer(G);
  gameFinished(rm, G);
  G.seq++; G.readyAt = Date.now() + last.d;
  if (last.fx && last.si !== undefined) last.sid = sidFor(rm, G.seats[last.si], last.fx);
  armTurnTimer(rm, G, last.d);
  const t = top(G);
  G.pl = { t: 'state', seq: G.seq, seats: G.seats.map((s, i) => ({ n: s.name, c: G.hands[i].length, b: s.bot ? 1 : 0, w: s.w })),
    turn: G.turn, top: enc(t), rot: t.rot || 0, shape: G.shape, pending: G.pending, mk: G.market.length,
    over: G.over ? 1 : 0, win: G.win, last, msg: msg || '', tl: turnLeft(G) };
  G.seats.forEach((s, i) => { if (!s.bot) { const p = rm.players.find((x) => x.pid === s.pid); if (p) sendSeat(rm, p, i); } });
  if (!G.over && G.seats[G.turn].bot) G.botT = setTimeout(() => botMove(rm, G), last.d + D(500));
}
function sendSeat(rm, p, i) {
  const G = rm.G;
  send(p.ws, Object.assign({}, G.pl, { me: i, host: p === host(rm), tl: turnLeft(G) }));
  send(p.ws, { t: 'hand', h: G.hands[i].map(enc), seq: G.seq });
}
function play(rm, si, i, cs) {
  const G = rm.G, c = G.hands[si].splice(i, 1)[0], nm = G.seats[si].name, nn = G.seats[nxt(G, si)].name;
  let again = false, skip = 0, fx = null, say = null;
  c.rot = Math.round(Math.random() * 16 - 8); G.pile.push(c); G.shape = c.s === 'whot' ? cs : c.s;
  let msg = nm + ' played ' + (c.n === 20 ? 'Whot' : c.n + ' of ' + c.s) + '.';
  switch (c.n) {
    case 1: again = true; msg = 'Hold on! ' + nm + ' plays again.'; break;
    case 2: G.pending += 2; msg = 'Pick two! ' + nn + ' must defend or pick ' + G.pending + '.'; fx = 'pick'; say = 'Pick two!'; break;
    case 5: G.pending += 3; msg = 'Pick three! ' + nn + ' must defend or pick ' + G.pending + '.'; fx = 'pick'; say = 'Pick three!'; break;
    case 8: skip = 1; msg = 'Suspension! ' + nn + ' misses a turn.'; break;
    case 14: G.seats.forEach((s, k) => { if (k !== si) draw(G, k, 1); }); again = true; msg = 'General market! Everyone else picks one.'; fx = 'market'; say = 'General market!'; break;
    case 20: msg = nm + ' called ' + cs + '.'; fx = 'whot'; say = 'Whot! ' + cs; break;
  }
  if (!G.hands[si].length) {
    G.over = true; G.win = si; G.seats[si].w++;
    publish(rm, { t: 'play', si, c: enc(c), d: D(900), fx: 'win', say: nm + ' wins' }, nm + ' wins!'); return;
  }
  if (G.hands[si].length === 1) { msg += ' Last card!'; if (!fx) { fx = 'last'; say = nm + ': last card!'; } }
  G.turn = again ? si : nxt(G, si, 1 + skip);
  publish(rm, { t: 'play', si, c: enc(c), d: D(1400), fx, say }, msg);
}
function drawAct(rm, si) {
  const G = rm.G, n = G.pending || 1; G.pending = 0; draw(G, si, n); G.turn = nxt(G, si);
  publish(rm, { t: 'draw', si, d: D(1000) }, G.seats[si].name + ' picked ' + n + ' card' + (n > 1 ? 's' : '') + '.');
}
function botMove(rm, G) {
  if (rm.G !== G || G.over || !G.seats[G.turn].bot) return;
  const si = G.turn, h = G.hands[si], opts = [];
  h.forEach((c, i) => { if (legal(G, c)) opts.push(i); });
  if (!opts.length) return drawAct(rm, si);
  const sp = opts.filter((i) => [1,2,5,8,14].includes(h[i].n)), norm = opts.filter((i) => h[i].n !== 20 && !sp.includes(i));
  const pool = norm.length ? (sp.length && Math.random() < 0.5 ? sp : norm) : (sp.length ? sp : opts);
  const idx = pool[Math.floor(Math.random() * pool.length)]; let shape = null;
  if (h[idx].n === 20) {
    const cnt = {}; h.forEach((c, i) => { if (i !== idx && c.s !== 'whot') cnt[c.s] = (cnt[c.s] || 0) + 1; });
    let best = SH[Math.floor(Math.random() * 5)], m = 0; for (const k in cnt) if (cnt[k] > m) { m = cnt[k]; best = k; }
    shape = best;
  }
  play(rm, si, idx, shape);
}
function act(rm, p, m) {
  const G = rm.G; if (!G || G.over || Date.now() < G.readyAt) return;
  const si = G.turn, s = G.seats[si]; if (s.bot || s.pid !== p.pid) return;
  if (m.t === 'draw') { s.missed = 0; return drawAct(rm, si); }
  if (m.t === 'play' && Number.isInteger(m.i)) {
    const c = G.hands[si][m.i]; if (!c || !legal(G, c)) return;
    if (c.n === 20 && !SH.includes(m.sh)) return;
    s.missed = 0;
    play(rm, si, m.i, c.n === 20 ? m.sh : null);
  }
}

/* ---------- ludo engine ---------- */
// One die: roll a 6 to leave the yard; a 6, a capture or a pawn home gives another roll.
// Two dice: each die is a separate move for any pawn; doubles, a capture or a pawn home give another roll.
const LOFF = [0, 13, 26, 39], LSAFE = [0, 8, 13, 21, 26, 34, 39, 47], LCOLS = { 2: [1, 3], 3: [1, 2, 3], 4: [1, 2, 3, 0] };
const lNext = (G, i) => (i + 1) % G.seats.length;
const die6 = () => 1 + Math.floor(Math.random() * 6);
function lStart(rm) {
  const hum = live(rm).slice(0, 4 - rm.bots), old = rm.G ? rm.G.seats : [];
  const seats = hum.map((p) => ({ pid: p.pid, clientId: p.cid, name: p.name, bot: false, w: 0, missed: 0 }));
  for (let k = 1; k <= rm.bots; k++) seats.push({ pid: 'bot' + k, name: 'Computer ' + k, bot: true, w: 0, missed: 0 });
  if (seats.length < 2) return;
  seats.forEach((s, i) => { s.col = LCOLS[seats.length][i]; const o = old.find((x) => x.pid === s.pid); if (o) s.w = o.w; });
  if (rm.G) { clearTimeout(rm.G.botT); clearTurnTimer(rm.G); }
  const nd = rm.dice === 2 ? 2 : 1;
  rm.G = { seats, tk: seats.map(() => [0, 0, 0, 0]), nd, turn: 0, phase: 'roll', dv: Array(nd).fill(1), used: Array(nd).fill(false), roll: 1, sixes: 0, ex: false, opts: [], auto: null, over: false, win: -1, seq: old.length ? rm.G.seq : 0, readyAt: 0, botT: null, turnT: null, turnDeadline: null, startedAt: Date.now() };
  roomStarted(rm); samplePeaks();
  lPub(rm, { t: 'start', d: D(1200) }, 'New game (' + (nd === 2 ? 'two dice' : 'one die') + '). ' + seats[0].name + ' goes first.');
}
function lOpts(G, si) {                               // legal (die, pawn) choices, one per distinct pawn position per die
  const o = [];
  G.dv.forEach((v, d) => {
    if (G.used[d]) return;
    const seen = {};
    G.tk[si].forEach((p, k) => { if ((p === 0 ? v === 6 : p + v <= 57) && !seen[p]) { seen[p] = 1; o.push({ d, k }); } });
  });
  return o;
}
function lPub(rm, last, msg) {
  const G = rm.G; clearTimeout(G.botT); clearTurnTimer(G);
  gameFinished(rm, G);
  G.seq++; G.readyAt = Date.now() + (last.d || 0);
  if (last.fx) last.sid = sidFor(rm, G.seats[last.si], last.fx);
  if (G.phase !== 'auto') armTurnTimer(rm, G, last.d);
  G.pl = { t: 'state', game: 'ludo', seq: G.seq, nd: G.nd, seats: G.seats.map((s, i) => ({ n: s.name, col: s.col, b: s.bot ? 1 : 0, w: s.w, tk: G.tk[i] })),
    turn: G.turn, phase: G.phase, dv: G.dv, used: G.used, roll: G.roll, opts: G.opts, over: G.over ? 1 : 0, win: G.win, last, msg: msg || '', tl: turnLeft(G) };
  G.seats.forEach((s, i) => { if (!s.bot) { const p = rm.players.find((x) => x.pid === s.pid); if (p) lSend(rm, p, i); } });
  if (G.over) return;
  const d = last.d || 0, cur = G.seats[G.turn];
  if (G.phase === 'auto') G.botT = setTimeout(() => lMove(rm, G, G.turn, G.auto.k, G.auto.d), d + D(300));
  else if (cur.bot) G.botT = setTimeout(() => lBotAct(rm, G), d + D(600));
}
function lBotAct(rm, G) {
  if (rm.G !== G || G.over || !G.seats[G.turn].bot) return;
  if (G.phase === 'roll') lRoll(rm, G, G.turn);
  else if (G.phase === 'pick') { const o = lChoose(G, G.turn); if (o) lMove(rm, G, G.turn, o.k, o.d); }
  else if (G.phase === 'auto' && G.auto) lMove(rm, G, G.turn, G.auto.k, G.auto.d);
}
function lSend(rm, p, i) { send(p.ws, Object.assign({}, rm.G.pl, { me: i, host: p === host(rm), tl: turnLeft(rm.G) })); }
function lPrompt(rm, G, si, last, msg) {              // ask a human to choose, or play the only sensible move automatically
  const keys = {}; G.opts.forEach((x) => { keys[G.dv[x.d] + ':' + G.tk[si][x.k]] = 1; });
  if (!G.seats[si].bot && Object.keys(keys).length > 1) { G.phase = 'pick'; G.auto = null; }
  else { G.phase = 'auto'; G.auto = G.seats[si].bot ? lChoose(G, si) : G.opts[0]; }
  lPub(rm, last, msg);
}
function lRoll(rm, G, si) {
  if (rm.G !== G || G.over || G.turn !== si || G.phase !== 'roll') return;
  const nm = G.seats[si].name, two = G.nd === 2;
  G.dv = Array.from({ length: G.nd }, die6); G.used = G.dv.map(() => false); G.roll = G.dv[0]; G.opts = []; G.auto = null;
  const dbl = two ? G.dv[0] === G.dv[1] : G.dv[0] === 6, fx = G.dv.includes(6) ? 'six' : null;
  const txt = two ? G.dv[0] + ' and ' + G.dv[1] : String(G.dv[0]), base = { t: 'roll', si, v: G.dv[0], dv: G.dv };
  G.ex = dbl;
  if (dbl && ++G.sixes === 3) { G.sixes = 0; G.ex = false; G.turn = lNext(G, si); return lPub(rm, Object.assign(base, { d: D(1800), fx }), nm + ' rolled ' + txt + ': three ' + (two ? 'doubles' : 'sixes') + ' in a row. Turn lost.'); }
  const o = lOpts(G, si);
  if (!o.length) { G.sixes = 0; G.ex = false; G.turn = lNext(G, si); return lPub(rm, Object.assign(base, { d: D(1800), fx }), nm + ' rolled ' + txt + '. No move possible.'); }
  G.opts = o;
  lPrompt(rm, G, si, Object.assign(base, { d: D(1300), fx }), nm + ' rolled ' + txt + '.');
}
function lChoose(G, si) {
  const col = G.seats[si].col; let best = G.opts[0], bs = -1;
  G.opts.forEach((o) => {
    const v = G.dv[o.d], p = G.tk[si][o.k], np = p === 0 ? 1 : p + v; let sc = np + Math.random() * 3;
    if (np === 57) sc += 100; if (p === 0) sc += 60; if (np >= 52 && np < 57) sc += 35;
    if (np <= 51) {
      const idx = (LOFF[col] + np - 1) % 52;
      if (LSAFE.includes(idx)) sc += 15;
      else G.seats.forEach((os, oi) => { if (oi !== si) G.tk[oi].forEach((q) => { if (q >= 1 && q <= 51 && (LOFF[os.col] + q - 1) % 52 === idx) sc += 80; }); });
    }
    if (sc > bs) { bs = sc; best = o; }
  });
  return best;
}
function lMove(rm, G, si, k, die) {
  die = die | 0;
  if (rm.G !== G || G.over || G.turn !== si || (G.phase !== 'pick' && G.phase !== 'auto')) return;
  if (!G.opts.some((o) => o.d === die && G.tk[si][o.k] === G.tk[si][k])) return;
  const v = G.dv[die], p = G.tk[si][k], np = p === 0 ? 1 : p + v, col = G.seats[si].col, cap = [];
  G.tk[si][k] = np; G.used[die] = true;
  if (np <= 51) {
    const idx = (LOFF[col] + np - 1) % 52;
    if (!LSAFE.includes(idx)) G.seats.forEach((o, oi) => { if (oi === si) return; G.tk[oi].forEach((q, j) => { if (q >= 1 && q <= 51 && (LOFF[o.col] + q - 1) % 52 === idx) { G.tk[oi][j] = 0; cap.push({ si: oi, k: j }); } }); });
  }
  const nm = G.seats[si].name, dly = D((p === 0 ? 1 : np - p) * 260 + (cap.length ? 1300 : 800));
  G.opts = []; G.auto = null; G.phase = 'roll';
  const ev = { t: 'move', si, k, die, from: p, to: np, cap, d: dly };
  if (G.tk[si].every((x) => x === 57)) { G.over = true; G.win = si; G.seats[si].w++; return lPub(rm, Object.assign(ev, { fx: 'win' }), nm + ' wins!'); }
  if (cap.length || np === 57) G.ex = true;
  const victims = cap.map((c) => G.seats[c.si].name).filter((x, i, a) => a.indexOf(x) === i).join(' and ');
  ev.fx = cap.length ? 'sent' : np === 57 ? 'home' : null;
  let msg = cap.length ? nm + ' sent ' + victims + ' back to the yard!' : np === 57 ? nm + ' got a pawn home!' : '';
  G.opts = lOpts(G, si);
  if (G.opts.length) return lPrompt(rm, G, si, ev, msg || nm + ' moved a pawn with the ' + v + '.');   // second die still to play
  G.opts = [];
  if (G.ex) { if (!msg) msg = nm + ' plays again.'; } else { G.sixes = 0; G.turn = lNext(G, si); }
  lPub(rm, ev, msg);
}
function lAct(rm, p, m) {
  const G = rm.G; if (!G || rm.game !== 'ludo' || G.over || Date.now() < G.readyAt) return;
  const si = G.turn, s = G.seats[si]; if (s.bot || s.pid !== p.pid) return;
  if (m.t === 'roll' && G.phase === 'roll') { s.missed = 0; lRoll(rm, G, si); }
  else if (m.t === 'move' && G.phase === 'pick' && Number.isInteger(m.k) && m.k >= 0 && m.k < 4 &&
      Number.isInteger(m.d) && G.opts.some((o) => o.d === m.d && G.tk[si][o.k] === G.tk[si][m.k])) {
    s.missed = 0; lMove(rm, G, si, m.k, m.d);
  }
}

/* ---------- shared helpers ---------- */
function startGame(rm) { return rm.game === 'ludo' ? lStart(rm) : whotStart(rm); }
function gpub(rm, last, msg) { return rm.game === 'ludo' ? lPub(rm, last, msg) : publish(rm, last, msg); }
function gsend(rm, p, i) { return rm.game === 'ludo' ? lSend(rm, p, i) : sendSeat(rm, p, i); }
function sidFor(rm, seat, fx) { const p = seat && rm.players.find((x) => x.pid === seat.pid); return (p && p.sfx && p.sfx[fx]) || null; }
const SID = /^[a-z0-9_-]{1,40}\/[a-z0-9_.-]{1,60}$/i, FXN = ['pick', 'market', 'whot', 'last', 'win', 'six', 'sent', 'home', 'turn'];
function setPrefs(p, m) { const o = {}; if (m.s && typeof m.s === 'object') FXN.forEach((k) => { if (typeof m.s[k] === 'string' && SID.test(m.s[k])) o[k] = m.s[k]; }); p.sfx = o; }
const CID = /^[a-z0-9_-]{1,80}$/i;
function hello(ws, m) {
  if (typeof m.cid !== 'string' || !CID.test(m.cid)) return;
  const username = clean(m.name);
  ws.clientId = m.cid; ws.clientName = username; ws.hello = true;
  const rm = rooms.get(ws.code), p = rm && rm.players.find((x) => x.pid === ws.pid && x.ws === ws);
  if (p) {
    p.cid = m.cid;
    if (rm.G) {
      const seat = rm.G.seats.find((x) => x.pid === p.pid);
      if (seat) seat.clientId = m.cid;
    }
  }
  db.upsertPlayer(m.cid, username).catch((err) => recordError('upsert player', err));
  clientRtts.set(m.cid, clientRtts.get(m.cid) || []);
  samplePeaks();
}
function submitFeedback(ws, m) {
  if (!ws.hello || m.client_id !== ws.clientId) return send(ws, { t: 'err', msg: 'Reconnect before sending feedback.' });
  const ratings = ['ux','responsiveness','latency','features','speed','entertainment'];
  if (ratings.some((key) => !Number.isInteger(m[key]) || m[key] < 1 || m[key] > 5)) return send(ws, { t: 'err', msg: 'All ratings must be from 1 to 5.' });
  const username = typeof m.username === 'string' ? m.username.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() : '';
  const comment = typeof m.comment === 'string' ? m.comment.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() : '';
  if (!username || Array.from(username).length > 12 || /[<>]/.test(username)) return send(ws, { t: 'err', msg: 'Enter a valid username (up to 12 characters).'});
  if (comment.length > 500) return send(ws, { t: 'err', msg: 'Comment must be 500 characters or fewer.' });
  if (!['whot','ludo','menu'].includes(m.game) || !['mobile','desktop'].includes(m.device) ||
      !['yes','no','maybe'].includes(m.voice)) return send(ws, { t: 'err', msg: 'Invalid feedback details.' });
  if (m.rtt_ms !== null && (!Number.isInteger(m.rtt_ms) || m.rtt_ms < 0 || m.rtt_ms > 60000)) return send(ws, { t: 'err', msg: 'Invalid latency measurement.' });
  if (typeof m.app_version !== 'string' || m.app_version.length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(m.app_version)) return send(ws, { t: 'err', msg: 'Invalid app version.' });
  const now = Date.now(), limit = feedbackLimits.get(ws.clientId) || { last: 0, times: [] };
  limit.times = limit.times.filter((at) => now - at < 3600000);
  if ((limit.last && now - limit.last < 60000) || limit.times.length >= 5) { feedbackLimits.set(ws.clientId, limit); return send(ws, { t: 'err', msg: 'Please wait before submitting feedback again.' }); }
  limit.last = now; limit.times.push(now); feedbackLimits.set(ws.clientId, limit);
  const data = { client_id: ws.clientId, username, game: m.game, device: m.device, rtt_ms: m.rtt_ms,
    ux: m.ux, responsiveness: m.responsiveness, latency: m.latency, features: m.features,
    speed: m.speed, entertainment: m.entertainment, voice: m.voice, comment, app_version: m.app_version };
  Promise.resolve().then(async () => {
    await db.recordFeedback(data);
    await db.upsertPlayer(ws.clientId, username);
    send(ws, { t: 'feedback_ok' });
  }).catch((err) => { recordError('save feedback', err); send(ws, { t: 'err', msg: 'Feedback could not be saved.' }); });
}

/* ---------- connections ---------- */
function handle(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') { hello(ws, m); return; }
  if (m.t === 'ping') {
    if (Number.isSafeInteger(m.ts)) {
      if (ws.clientId && Number.isInteger(m.rtt_ms) && m.rtt_ms >= 0 && m.rtt_ms <= 60000) {
        const samples = clientRtts.get(ws.clientId) || [];
        samples.push(m.rtt_ms); if (samples.length > 10) samples.shift(); clientRtts.set(ws.clientId, samples);
      }
      send(ws, { t: 'pong', ts: m.ts });
    }
    return;
  }
  if (m.t === 'feedback') { submitFeedback(ws, m); return; }
  if (m.t === 'create') { if (!ws.pid) addPlayer(mkRoom(m.game === 'ludo' ? 'ludo' : 'whot'), ws, m.name); return; }
  if (m.t === 'join') {
    if (ws.pid) return;
    const rm = rooms.get(String(m.code || '').toUpperCase());
    if (!rm) return send(ws, { t: 'err', msg: 'No game found with that code.' });
    if (rm.G && !rm.G.over) return send(ws, { t: 'err', msg: 'That game has already started.' });
    if (live(rm).length + rm.bots >= 4) return send(ws, { t: 'err', msg: 'That room is full.' });
    addPlayer(rm, ws, m.name); return;
  }
  if (m.t === 'rejoin') {
    const rm = rooms.get(String(m.code || '').toUpperCase()), p = rm && rm.players.find((x) => x.pid === m.pid && !x.gone);
    if (!p) return send(ws, { t: 'err', expired: true, msg: 'That game has ended. Start or join a new one.' });
    clearTimeout(p.timer); const old = p.ws; p.ws = ws; p.cid = ws.clientId || p.cid; ws.pid = p.pid; ws.code = rm.code;
    if (old && old !== ws) try { old.close(); } catch (e) {}
    send(ws, { t: 'joined', game: rm.game, code: rm.code, pid: p.pid }); lobby(rm); send(ws, { t: 'chatlog', list: rm.chat });
    samplePeaks();
    if (rm.G) {
      const i = rm.G.seats.findIndex((s) => s.pid === p.pid);
      if (i > -1) { if (rm.G.turn === i && !rm.G.seats[i].bot && !rm.G.turnT) armTurnTimer(rm, rm.G, 0); gsend(rm, p, i); }
    }
    return;
  }
  const rm = rooms.get(ws.code), p = rm && rm.players.find((x) => x.pid === ws.pid); if (!p) return;
  switch (m.t) {
    case 'addbot': if (p === host(rm) && !rm.G && live(rm).length + rm.bots < 4) { rm.bots++; lobby(rm); } break;
    case 'start': if (p === host(rm) && (!rm.G || rm.G.over)) startGame(rm); break;
    case 'play': case 'draw': if (rm.game === 'whot') act(rm, p, m); break;
    case 'roll': case 'move': if (rm.game === 'ludo') lAct(rm, p, m); break;
    case 'setdice': if (p === host(rm) && rm.game === 'ludo' && (!rm.G || rm.G.over) && (m.n === 1 || m.n === 2)) { rm.dice = m.n; lobby(rm); } break;
    case 'prefs': setPrefs(p, m); break;
    case 'chat': chat(rm, p, m); break;
    case 'leave': ws.pid = null; ws.code = null; drop(rm, p); break;
  }
}
wss.on('connection', (ws) => {
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => { let m; try { m = JSON.parse(raw); } catch (e) { return; } try { handle(ws, m); } catch (e) { recordError('websocket message', e); } });
  ws.on('close', () => {
    const rm = rooms.get(ws.code), p = rm && rm.players.find((x) => x.pid === ws.pid);
    if (!p || p.ws !== ws) return;
    p.ws = null; p.timer = setTimeout(() => drop(rm, p), D(rm.G && !rm.G.over ? 45000 : 20000));
  });
});
setInterval(() => { wss.clients.forEach((ws) => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }); }, 25000);
setInterval(() => {                                   // remove rooms nobody is connected to
  for (const [code, rm] of rooms) {
    if (rm.players.some((p) => p.ws)) { rm.idle = 0; continue; }
    if (!rm.idle) rm.idle = Date.now(); else if (Date.now() - rm.idle > 120000) { if (rm.G) { clearTimeout(rm.G.botT); clearTurnTimer(rm.G); } rooms.delete(code); }
  }
}, 30000);

function liveAdminSnapshot() {
  const now = Date.now(), roomList = [], byGame = { whot: 0, ludo: 0 };
  let roomsInLobby = 0, roomsInProgress = 0, computerPlayers = 0;
  for (const rm of rooms.values()) {
    byGame[rm.game] = (byGame[rm.game] || 0) + 1;
    const active = !!(rm.G && !rm.G.over);
    if (active) roomsInProgress++; else roomsInLobby++;
    const names = active ? rm.G.seats.map((s) => s.name) :
      live(rm).map((p) => p.name).concat(Array.from({ length: rm.bots }, (_, i) => 'Computer ' + (i + 1)));
    computerPlayers += active ? rm.G.seats.filter((s) => s.bot).length : rm.bots;
    roomList.push({ code: rm.code, game: rm.game, names, seats: names.length,
      phase: active ? (rm.G.phase || (rm.G.pending ? 'defend' : 'play')) : 'lobby',
      ageSeconds: Math.max(0, Math.floor((now - rm.createdAt) / 1000)) });
  }
  const playersOnline = Array.from(wss.clients).filter((ws) => ws.readyState === 1 && ws.hello).length;
  while (chatMinute.length && now - chatMinute[0] > 60000) chatMinute.shift();
  const samples = Array.from(clientRtts.values()).reduce((all, values) => all.concat(values), []);
  return { playersOnline, rooms: byGame, roomsInLobby, roomsInProgress, computerPlayers,
    messagesPerMinute: chatMinute.length,
    currentNotice: activeNotice && activeNotice.until > now ? activeNotice.text : null, roomList,
    averageRtt: samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null };
}
async function adminStats(url) {
  const params = url.searchParams, game = ['whot','ludo'].includes(params.get('game')) ? params.get('game') : null;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(params.get('from') || '') ? params.get('from') : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(params.get('to') || '') ? params.get('to') : null;
  const data = await db.adminData({ game, from, to }), liveNow = liveAdminSnapshot(), daily = new Map();
  data.daily.forEach((row) => daily.set(String(row.day).slice(0, 10) + ':' + row.game, { ...row, day: String(row.day).slice(0, 10) }));
  pendingStats.forEach((row, key) => {
    const prior = daily.get(key);
    if (prior) {
      ['rooms_created','rooms_started','games_finished','total_game_seconds'].forEach((field) => { prior[field] = Number(prior[field] || 0) + row[field]; });
      prior.peak_players = Math.max(Number(prior.peak_players) || 0, row.peak_players);
    } else daily.set(key, { ...row });
  });
  const health = { uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000), restarts7d: await db.recentBoots(),
    memory: process.memoryUsage(), eventLoopLagMs: eventLoopLag, errorsLastHour: errorTimes.length,
    errors: errors.slice(), database: db.status, averageClientRtt: liveNow.averageRtt };
  return { live: liveNow, daily: Array.from(daily.values()).sort((a, b) => String(a.day).localeCompare(String(b.day)) || a.game.localeCompare(b.game)),
    feedback: data.feedback, players: data.players, health };
}
function broadcastNotice(text, minutes) {
  activeNotice = { text, until: Date.now() + minutes * 60000 };
  rooms.forEach((rm) => rm.players.forEach((p) => send(p.ws, { t: 'notice', text })));
  setTimeout(() => { if (activeNotice && activeNotice.until <= Date.now()) activeNotice = null; }, minutes * 60000).unref();
}
function closeRoom(code) {
  const rm = rooms.get(code); if (!rm) return false;
  if (rm.G) { clearTimeout(rm.G.botT); clearTurnTimer(rm.G); }
  rm.players.forEach((p) => {
    clearTimeout(p.timer);
    if (p.ws) { const client = p.ws; send(client, { t: 'kicked', reason: 'closed' }); client.pid = null; client.code = null; client.close(); }
  });
  rooms.delete(code); return true;
}
async function deletePlayer(clientId) {
  await db.deletePlayer(clientId); clientRtts.delete(clientId); feedbackLimits.delete(clientId);
}
adminRoute = createAdminRouter({ db, getStats: adminStats, broadcastNotice, closeRoom, deletePlayer, recordError });
async function flushStats() {
  if (flushingStats) { await flushingStats; return flushStats(); }
  const rows = Array.from(pendingStats.values()).filter((r) =>
    r.rooms_created || r.rooms_started || r.games_finished || r.total_game_seconds || r.peak_players);
  if (!rows.length) return;
  const sentRows = rows.map((r) => ({ ...r }));
  flushingStats = db.flushDaily(sentRows);
  try {
    await flushingStats;
    sentRows.forEach((sent) => {
      const current = pendingStats.get(sent.day + ':' + sent.game);
      if (!current) return;
      ['rooms_created','rooms_started','games_finished','total_game_seconds'].forEach((key) => { current[key] = Math.max(0, current[key] - sent[key]); });
      if (current.peak_players <= sent.peak_players) current.peak_players = 0;
      if (!current.rooms_created && !current.rooms_started && !current.games_finished && !current.total_game_seconds && !current.peak_players)
        pendingStats.delete(sent.day + ':' + sent.game);
    });
  } finally { flushingStats = null; }
}
const dbReady = db.init().catch((err) => recordError('initialize database', err));
setInterval(() => { flushStats().catch((err) => recordError('flush daily stats', err)); }, 300000);
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  const force = setTimeout(() => process.exit(1), 10000); force.unref();
  Promise.resolve(dbReady).then(flushStats).then(() => db.close()).then(() => {
    server.close(() => process.exit(0)); wss.close();
  }).catch((err) => { recordError('shutdown', err); process.exit(1); });
}
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
server.listen(PORT, () => console.log('Naija Whot server on http://localhost:' + PORT));
