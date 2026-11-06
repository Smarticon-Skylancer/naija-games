'use strict';
const crypto = require('crypto');
const EXPORT_COLUMNS = {
  feedback: ['id','created_at','client_id','username','game','device','rtt_ms','ux','responsiveness','latency','features','speed','entertainment','voice','comment','app_version'],
  players: ['client_id','username','first_seen','last_seen','games_played'],
  daily: ['day','game','rooms_created','rooms_started','games_finished','total_game_seconds','peak_players']
};

function createAdminRouter(options) {
  const failures = new Map();
  function headers(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  function json(res, status, value) {
    headers(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  }
  function authenticate(req, res) {
    const expected = process.env.ADMIN_KEY || '';
    if (expected.length < 16) { headers(res); res.writeHead(404); res.end('Not found'); return false; }
    const now = Date.now(), ip = req.socket.remoteAddress || 'unknown';
    const attempts = (failures.get(ip) || []).filter((t) => now - t < 900000);
    failures.set(ip, attempts);
    if (attempts.length >= 5) { headers(res); res.writeHead(429); res.end('Too many failed attempts'); return false; }
    const auth = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || '');
    let password = '';
    if (auth) {
      try { password = Buffer.from(auth[1], 'base64').toString('utf8').split(':').slice(1).join(':'); } catch (err) {}
    }
    const expectedHash = crypto.createHash('sha256').update(expected).digest();
    const passwordHash = crypto.createHash('sha256').update(password).digest();
    if (!auth || !crypto.timingSafeEqual(expectedHash, passwordHash)) {
      attempts.push(now); failures.set(ip, attempts);
      headers(res); res.setHeader('WWW-Authenticate', 'Basic realm="Naija Games Admin"');
      res.writeHead(401); res.end('Authentication required'); return false;
    }
    failures.delete(ip); headers(res); return true;
  }
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = '', ended = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 8192 && !ended) { ended = true; reject(new Error('Request too large')); req.destroy(); }
      });
      req.on('end', () => {
        if (ended) return;
        try { resolve(JSON.parse(body || '{}')); } catch (err) { reject(new Error('Invalid JSON')); }
      });
      req.on('error', (err) => { if (!ended) reject(err); });
    });
  }
  function cell(value) {
    let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function page() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Naija Games Admin</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:16px;background:#f3ecd9;color:#1d2b22;font:15px system-ui,sans-serif}main{max-width:1200px;margin:auto}h1{margin:0 0 12px}h2{margin:0 0 12px;font-size:1.2rem}section{background:#fffaf0;border-radius:12px;padding:16px;margin:14px 0;box-shadow:0 2px 8px #0002;overflow:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.stat{padding:10px;background:#eee7d7;border-radius:8px}.stat b{display:block;font-size:1.35rem}.bar{height:10px;background:#ddd;border-radius:8px;overflow:hidden}.bar i{display:block;height:100%;background:#c58a00}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}input,select,textarea,button{font:inherit;padding:9px;border:1px solid #999;border-radius:7px;min-height:40px}button{background:#f2b705;border:0;font-weight:700;cursor:pointer}table{border-collapse:collapse;width:100%;min-width:500px}th,td{text-align:left;padding:7px;border-bottom:1px solid #ddd;vertical-align:top;overflow-wrap:anywhere}.muted{color:#59675d}.status{font-weight:700;color:#a3150f}@media(max-width:600px){body{padding:8px}section{padding:12px}}
</style></head><body><main>
<h1>Naija Games Admin</h1><p class="muted">Private dashboard. Do not share the admin key.</p>
<section><h2>Admin access</h2><div class="row"><label for="key">ADMIN_KEY</label><input id="key" type="password" autocomplete="current-password"><button id="saveKey">Connect</button><span id="status" class="status"></span></div></section>
<div id="dashboard" hidden>
<section><h2>Live now</h2><div id="live" class="grid"></div><p id="notice"></p><h3>Rooms</h3><div id="rooms"></div></section>
<section><h2>Trends (30 days)</h2><div id="trends"></div></section>
<section><h2>Players</h2><div id="playersTop"></div><label>Search usernames <input id="playerSearch" type="search"></label><div id="players"></div></section>
<section><h2>Health</h2><div id="health" class="grid"></div><h3>Recent errors</h3><div id="errors"></div></section>
<section><h2>Feedback</h2><form id="filters" class="row"><label>Game <select name="game"><option value="">All</option><option>whot</option><option>ludo</option></select></label><label>From <input name="from" type="date"></label><label>To <input name="to" type="date"></label><button>Apply</button></form><div id="feedback"></div></section>
<section><h2>Controls</h2><form id="noticeForm" class="row"><input name="text" maxlength="300" required placeholder="Notice text"><input name="minutes" type="number" min="1" max="1440" value="10" required><button>Broadcast notice</button></form>
<form id="closeForm" class="row"><input name="code" maxlength="4" required placeholder="Room code"><button>Close room</button></form>
<form id="deleteForm" class="row"><input name="client_id" required placeholder="Anonymous client ID"><button>Delete player and feedback</button></form>
<div class="row"><button data-export="feedback">Download feedback CSV</button><button data-export="players">Download players CSV</button><button data-export="daily">Download daily CSV</button></div><p id="controlStatus" role="status"></p></section>
</div></main>
<script>
(()=>{const $=id=>document.getElementById(id),esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key=$('key');key.value=sessionStorage.getItem('ng_admin_key')||'';
function auth(){return 'Basic '+btoa('admin:'+key.value)}
function call(url,options={}){options.headers=Object.assign({},options.headers,{Authorization:auth()});if(options.method==='POST')options.headers['X-Admin']='1';return fetch(url,options)}
function table(rows,cols){return '<table><thead><tr>'+cols.map(c=>'<th>'+esc(c[1])+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+esc(r[c[0]])+'</td>').join('')+'</tr>').join('')+'</tbody></table>'}
function card(label,value){return '<div class="stat"><span>'+esc(label)+'</span><b>'+esc(value==null?'—':value)+'</b></div>'}
function split(obj){return Object.keys(obj||{}).map(k=>esc(k)+': '+esc(obj[k])).join(' · ')||'None'}
function render(d){
const l=d.live;$('dashboard').hidden=false;$('status').textContent='Connected';
$('live').innerHTML=[card('Players online',l.playersOnline),card('Whot rooms',l.rooms.whot||0),card('Ludo rooms',l.rooms.ludo||0),card('In lobby',l.roomsInLobby),card('In progress',l.roomsInProgress),card('Computer players',l.computerPlayers),card('Chat messages/min',l.messagesPerMinute)].join('');
$('notice').textContent='Current notice: '+(l.currentNotice||'None');
$('rooms').innerHTML=table(l.roomList,[['code','Code'],['game','Game'],['names','Players'],['seats','Seats'],['phase','Phase'],['ageSeconds','Age (s)']]);
$('trends').innerHTML=table(d.daily.map(x=>Object.assign({},x,{avg_seconds:x.games_finished?Math.round(Number(x.total_game_seconds)/x.games_finished):0,dropoff:Math.max(0,x.rooms_created-x.rooms_started)})),[['day','Day'],['game','Game'],['rooms_started','Games started'],['games_finished','Finished'],['avg_seconds','Average seconds'],['peak_players','Peak players'],['dropoff','Never started']]);
$('playersTop').innerHTML='<p>Total: '+esc(d.players.total)+' · New today: '+esc(d.players.newToday)+' · Returning: '+esc(d.players.returning)+'</p><h3>Top 10</h3>'+table(d.players.top,[['username','Username'],['games_played','Games played'],['last_seen','Last seen']]);
const q=$('playerSearch').value.toLowerCase(),people=d.players.list.filter(p=>String(p.username||'').toLowerCase().includes(q));
$('players').innerHTML=table(people,[['username','Username'],['client_id','Client ID'],['first_seen','First seen'],['last_seen','Last seen'],['games_played','Games played']]);
const h=d.health;$('health').innerHTML=[card('Uptime (s)',h.uptimeSeconds),card('Restarts, 7 days',h.restarts7d),card('RSS MB',(h.memory.rss/1048576).toFixed(1)),card('Heap MB',(h.memory.heapUsed/1048576).toFixed(1)),card('Event loop lag (ms)',h.eventLoopLagMs),card('Errors, last hour',h.errorsLastHour),card('Database',h.database),card('Average RTT (ms)',h.averageClientRtt)].join('');
$('errors').innerHTML='<ul>'+h.errors.map(e=>'<li>'+esc(e.ts)+' — '+esc(e.message)+'</li>').join('')+'</ul>';
const f=d.feedback,labels={ux:'User experience',responsiveness:'Responsiveness',latency:'Latency',features:'Features',speed:'Speed',entertainment:'Entertainment'};
let ratings='<p>Responses: '+esc(f.count)+'</p>'+Object.keys(labels).map(k=>'<p>'+esc(labels[k])+': '+(f.averages[k]==null?'—':Number(f.averages[k]).toFixed(2))+' / 5 <span class="bar"><i style="width:'+Math.max(0,Math.min(100,(f.averages[k]||0)*20))+'%"></i></span>'+(k==='latency'?' · measured RTT: '+esc(f.averageRtt==null?'—':Math.round(f.averageRtt)+' ms'):'')+'</p>').join('');
ratings+='<p>Voice chat: '+esc(split(f.voice))+'</p><p>By game: '+esc(split(f.game))+'</p><p>By device: '+esc(split(f.device))+'</p><h3>Latest comments</h3>'+table(f.comments,[['username','Username'],['created_at','Date'],['game','Game'],['comment','Comment']]);
$('feedback').innerHTML=ratings;
}
async function load(){if(!key.value)return;$('status').textContent='Loading…';try{const query=new URLSearchParams(new FormData($('filters')));const r=await call('/admin/api/stats?'+query);if(!r.ok){$('status').textContent='Access failed ('+r.status+'). Check the key.';return}render(await r.json())}catch(e){$('status').textContent='Dashboard request failed.'}}
$('saveKey').onclick=()=>{sessionStorage.setItem('ng_admin_key',key.value);load()};
$('playerSearch').oninput=load;$('filters').onsubmit=e=>{e.preventDefault();load()};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});setInterval(()=>{if(!document.hidden)load()},5000);
async function post(form,url){const body=Object.fromEntries(new FormData(form));if(body.minutes)body.minutes=Number(body.minutes);const r=await call(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});$('controlStatus').textContent=r.ok?'Done.':'Request failed ('+r.status+').';if(r.ok)load()}
[['noticeForm','/admin/api/notice'],['closeForm','/admin/api/close-room'],['deleteForm','/admin/api/delete-player']].forEach(([id,url])=>$(id).onsubmit=e=>{e.preventDefault();post(e.currentTarget,url)});
document.querySelectorAll('[data-export]').forEach(b=>b.onclick=async()=>{const r=await call('/admin/export.csv?table='+b.dataset.export);if(!r.ok){$('controlStatus').textContent='Export failed ('+r.status+').';return}const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download=b.dataset.export+'.csv';a.click();URL.revokeObjectURL(a.href)});
if(key.value)load()})();
</script></body></html>`;
  }
  return async function adminRoute(req, res, pathname) {
    if (!authenticate(req, res)) return;
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page());
    }
    if (req.method === 'GET' && pathname === '/admin/api/stats') {
      try { json(res, 200, await options.getStats(url)); }
      catch (err) { options.recordError('admin stats', err); json(res, 500, { error: 'Could not load stats.' }); }
      return;
    }
    if (req.method === 'GET' && pathname === '/admin/export.csv') {
      const tableName = url.searchParams.get('table');
      if (!['feedback','players','daily'].includes(tableName)) return json(res, 400, { error: 'Unknown export table.' });
      const rows = await options.db.exportRows(tableName), cols = EXPORT_COLUMNS[tableName];
      const csv = [cols.map(cell).join(','), ...rows.map((row) => cols.map((key) => cell(row[key])).join(','))].join('\r\n');
      headers(res); res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + tableName + '.csv"' }); res.end(csv); return;
    }
    if (req.method === 'POST' && pathname.startsWith('/admin/api/')) {
      if (req.headers['x-admin'] !== '1') return json(res, 403, { error: 'Missing CSRF header.' });
      let body;
      try { body = await readJson(req); } catch (err) { return json(res, err.message === 'Request too large' ? 413 : 400, { error: err.message }); }
      if (pathname === '/admin/api/notice') {
        const text = typeof body.text === 'string' ? body.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() : '';
        if (!text || text.length > 300 || !Number.isInteger(body.minutes) || body.minutes < 1 || body.minutes > 1440)
          return json(res, 400, { error: 'Notice must be 1-300 characters and last 1-1440 minutes.' });
        options.broadcastNotice(text, body.minutes); return json(res, 200, { ok: true });
      }
      if (pathname === '/admin/api/close-room') {
        const code = typeof body.code === 'string' ? body.code.toUpperCase() : '';
        if (!/^[A-Z0-9]{4}$/.test(code) || !options.closeRoom(code)) return json(res, 404, { error: 'Room not found.' });
        return json(res, 200, { ok: true });
      }
      if (pathname === '/admin/api/delete-player') {
        if (typeof body.client_id !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(body.client_id)) return json(res, 400, { error: 'Invalid client ID.' });
        await options.deletePlayer(body.client_id); return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Not found.' });
    }
    headers(res); res.writeHead(404); res.end('Not found');
  };
}
module.exports = createAdminRouter;
