'use strict';
// Naija Whot: authoritative game server. Serves the page and runs rooms over WebSockets.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const T = process.env.FAST ? 0.05 : 1;            // FAST=1 shortens delays (testing only)
const D = (ms) => Math.round(ms * T);

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
  if (u === '/healthz') return res.end('ok');
  if (u === '/api/sounds') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(JSON.stringify(soundList())); }
  const f = u === '/' ? '/index.html' : u === '/whot' ? '/whot.html' : u === '/ludo' ? '/ludo.html' : u;
  const full = path.normalize(path.join(PUB, f));
  if (!full.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': f.startsWith('/sounds/') ? 'public, max-age=86400' : 'no-cache' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 2048 });

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
const rid = () => Math.random().toString(36).slice(2, 10);
const clean = (n) => String(n || '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, 12) || 'Player';
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function mkRoom(game) {
  let code; do { code = Array.from({ length: 4 }, () => AL[Math.floor(Math.random() * AL.length)]).join(''); } while (rooms.has(code));
  const rm = { code, game, dice: 1, players: [], bots: 0, G: null, idle: 0 }; rooms.set(code, rm); return rm;
}
const live = (rm) => rm.players.filter((p) => !p.gone);
const host = (rm) => live(rm)[0];
function lobby(rm) {
  const hs = host(rm), L = live(rm), list = L.map((p) => ({ n: p.name, h: p === hs }));
  L.forEach((p, i) => send(p.ws, { t: 'lobby', game: rm.game, dice: rm.dice, code: rm.code, list, bots: rm.bots, host: p === hs, me: i }));
}
function addPlayer(rm, ws, name) {
  const p = { pid: rid() + rid(), name: clean(name), ws, gone: false, timer: null };
  rm.players.push(p); ws.pid = p.pid; ws.code = rm.code;
  send(ws, { t: 'joined', game: rm.game, code: rm.code, pid: p.pid }); lobby(rm); return p;
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
  if (!rm.players.length) { if (rm.G) clearTimeout(rm.G.botT); rooms.delete(rm.code); return; }
  lobby(rm);
}

/* ---------- game engine ---------- */
function whotStart(rm) {
  const hum = live(rm).slice(0, 4 - rm.bots), old = rm.G ? rm.G.seats : [];
  const seats = hum.map((p) => ({ pid: p.pid, name: p.name, bot: false, w: 0 }));
  for (let k = 1; k <= rm.bots; k++) seats.push({ pid: 'bot' + k, name: 'Computer ' + k, bot: true, w: 0 });
  if (seats.length < 2) return;
  seats.forEach((s) => { const o = old.find((x) => x.pid === s.pid); if (o) s.w = o.w; });
  if (rm.G) clearTimeout(rm.G.botT);
  const d = []; SH.forEach((s) => SET[s].forEach((n) => d.push({ s, n })));
  for (let i = 0; i < 5; i++) d.push({ s: 'whot', n: 20 });
  shuffle(d);
  const G = rm.G = { seats, market: d, pile: [], hands: seats.map(() => []), turn: 0, pending: 0, shape: null, over: false, win: -1, seq: old.length ? rm.G.seq : 0, readyAt: 0, botT: null };
  const per = seats.length === 2 ? 6 : 5;
  for (let k = 0; k < per; k++) seats.forEach((s, j) => G.hands[j].push(G.market.pop()));
  let t; do { t = G.market.pop(); if ([1,2,5,8,14,20].includes(t.n)) { G.market.unshift(t); t = null; } } while (!t);
  t.rot = 0; G.pile.push(t); G.shape = t.s;
  publish(rm, { t: 'start', d: D(1200) }, 'New game. ' + seats[0].name + ' goes first.');
}
function publish(rm, last, msg) {
  const G = rm.G; G.seq++; G.readyAt = Date.now() + last.d;
  if (last.fx && last.si !== undefined) last.sid = sidFor(rm, G.seats[last.si], last.fx);
  const t = top(G);
  G.pl = { t: 'state', seq: G.seq, seats: G.seats.map((s, i) => ({ n: s.name, c: G.hands[i].length, b: s.bot ? 1 : 0, w: s.w })),
    turn: G.turn, top: enc(t), rot: t.rot || 0, shape: G.shape, pending: G.pending, mk: G.market.length,
    over: G.over ? 1 : 0, win: G.win, last, msg: msg || '' };
  G.seats.forEach((s, i) => { if (!s.bot) { const p = rm.players.find((x) => x.pid === s.pid); if (p) sendSeat(rm, p, i); } });
  clearTimeout(G.botT);
  if (!G.over && G.seats[G.turn].bot) G.botT = setTimeout(() => botMove(rm, G), last.d + D(500));
}
function sendSeat(rm, p, i) {
  const G = rm.G;
  send(p.ws, Object.assign({}, G.pl, { me: i, host: p === host(rm) }));
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
  if (m.t === 'draw') return drawAct(rm, si);
  if (m.t === 'play' && Number.isInteger(m.i)) {
    const c = G.hands[si][m.i]; if (!c || !legal(G, c)) return;
    if (c.n === 20 && !SH.includes(m.sh)) return;
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
  const seats = hum.map((p) => ({ pid: p.pid, name: p.name, bot: false, w: 0 }));
  for (let k = 1; k <= rm.bots; k++) seats.push({ pid: 'bot' + k, name: 'Computer ' + k, bot: true, w: 0 });
  if (seats.length < 2) return;
  seats.forEach((s, i) => { s.col = LCOLS[seats.length][i]; const o = old.find((x) => x.pid === s.pid); if (o) s.w = o.w; });
  if (rm.G) { clearTimeout(rm.G.botT); clearTimeout(rm.G.turnT); }
  const nd = rm.dice === 2 ? 2 : 1;
  rm.G = { seats, tk: seats.map(() => [0, 0, 0, 0]), nd, turn: 0, phase: 'roll', dv: Array(nd).fill(1), used: Array(nd).fill(false), roll: 1, sixes: 0, ex: false, opts: [], auto: null, over: false, win: -1, seq: old.length ? rm.G.seq : 0, readyAt: 0, botT: null, turnT: null };
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
  const G = rm.G; G.seq++; G.readyAt = Date.now() + (last.d || 0);
  if (last.fx) last.sid = sidFor(rm, G.seats[last.si], last.fx);
  G.pl = { t: 'state', game: 'ludo', seq: G.seq, nd: G.nd, seats: G.seats.map((s, i) => ({ n: s.name, col: s.col, b: s.bot ? 1 : 0, w: s.w, tk: G.tk[i] })),
    turn: G.turn, phase: G.phase, dv: G.dv, used: G.used, roll: G.roll, opts: G.opts, over: G.over ? 1 : 0, win: G.win, last, msg: msg || '' };
  G.seats.forEach((s, i) => { if (!s.bot) { const p = rm.players.find((x) => x.pid === s.pid); if (p) lSend(rm, p, i); } });
  clearTimeout(G.botT); clearTimeout(G.turnT);
  if (G.over) return;
  const d = last.d || 0, cur = G.seats[G.turn];
  if (G.phase === 'auto') G.botT = setTimeout(() => lMove(rm, G, G.turn, G.auto.k, G.auto.d), d + D(300));
  else if (cur.bot) G.botT = setTimeout(() => { if (G.phase === 'roll') lRoll(rm, G, G.turn); else { const o = lChoose(G, G.turn); lMove(rm, G, G.turn, o.k, o.d); } }, d + D(600));
  else G.turnT = setTimeout(() => { if (G.phase === 'roll') lRoll(rm, G, G.turn); else { const o = G.opts[0]; lMove(rm, G, G.turn, o.k, o.d); } }, d + D(60000));
}
function lSend(rm, p, i) { send(p.ws, Object.assign({}, rm.G.pl, { me: i, host: p === host(rm) })); }
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
  if (m.t === 'roll') lRoll(rm, G, si);
  else if (m.t === 'move' && Number.isInteger(m.k) && G.phase === 'pick') lMove(rm, G, si, m.k, m.d);
}

/* ---------- shared helpers ---------- */
function startGame(rm) { return rm.game === 'ludo' ? lStart(rm) : whotStart(rm); }
function gpub(rm, last, msg) { return rm.game === 'ludo' ? lPub(rm, last, msg) : publish(rm, last, msg); }
function gsend(rm, p, i) { return rm.game === 'ludo' ? lSend(rm, p, i) : sendSeat(rm, p, i); }
function sidFor(rm, seat, fx) { const p = seat && rm.players.find((x) => x.pid === seat.pid); return (p && p.sfx && p.sfx[fx]) || null; }
const SID = /^[a-z0-9_-]{1,40}\/[a-z0-9_.-]{1,60}$/i, FXN = ['pick', 'market', 'whot', 'last', 'win', 'six', 'sent', 'home'];
function setPrefs(p, m) { const o = {}; if (m.s && typeof m.s === 'object') FXN.forEach((k) => { if (typeof m.s[k] === 'string' && SID.test(m.s[k])) o[k] = m.s[k]; }); p.sfx = o; }

/* ---------- connections ---------- */
function handle(ws, m) {
  if (!m || typeof m.t !== 'string') return;
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
    clearTimeout(p.timer); const old = p.ws; p.ws = ws; ws.pid = p.pid; ws.code = rm.code;
    if (old && old !== ws) try { old.close(); } catch (e) {}
    send(ws, { t: 'joined', game: rm.game, code: rm.code, pid: p.pid }); lobby(rm);
    if (rm.G) { const i = rm.G.seats.findIndex((s) => s.pid === p.pid); if (i > -1) gsend(rm, p, i); }
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
    case 'leave': ws.pid = null; ws.code = null; drop(rm, p); break;
  }
}
wss.on('connection', (ws) => {
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => { let m; try { m = JSON.parse(raw); } catch (e) { return; } try { handle(ws, m); } catch (e) { console.error(e); } });
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
    if (!rm.idle) rm.idle = Date.now(); else if (Date.now() - rm.idle > 120000) { if (rm.G) clearTimeout(rm.G.botT); rooms.delete(code); }
  }
}, 30000);
server.listen(PORT, () => console.log('Naija Whot server on http://localhost:' + PORT));
