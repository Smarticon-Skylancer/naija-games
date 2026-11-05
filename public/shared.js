/* Shared shell for every game page: connection, lobby, end screen and the sound system. */
(function(){
var W=window.W={},G=null,ws=null,retry=0,opts={voice:true,mute:false,others:true,clean:false},map={},custom={},lib={packs:[]},idx={};
var $=W.$=function(id){return document.getElementById(id)};
W.esc=function(t){return String(t).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
W.isHost=false;
function ls(k,v){try{if(v===undefined)return localStorage.getItem(k);if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v)}catch(e){}return null}
W.send=function(o){if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))};
W.open=function(){return !!ws&&ws.readyState===1};

/* ---------- sounds ---------- */
function speak(t){if(!opts.voice||opts.mute||!window.speechSynthesis||!t)return;try{speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance(t))}catch(e){}}
W.fire=function(ev,text,sid){
  if(opts.mute)return;
  var url=null,m=map[ev];
  if(sid&&opts.others&&idx[sid]&&!(idx[sid].explicit&&opts.clean))url='/sounds/'+sid;
  else if(m&&m.indexOf('L:')===0&&idx[m.slice(2)]&&!(idx[m.slice(2)].explicit&&opts.clean))url='/sounds/'+m.slice(2);
  else if(m==='C'&&custom[ev])url=custom[ev];
  if(url){try{new Audio(url).play().catch(function(){})}catch(e){}}else speak(text);
};
function saveMap(){ls('ng_map',JSON.stringify(map))}
function sendPrefs(){var s={};for(var e in map)if(map[e]&&map[e].indexOf('L:')===0)s[e]=map[e].slice(2);W.send({t:'prefs',s:s})}
function preview(ev){var m=opts.mute;opts.mute=false;var t=G.ev.filter(function(e){return e[0]===ev})[0];W.fire(ev,t?t[2]:'',null);opts.mute=m}
function fillSelects(){
  Array.prototype.forEach.call(document.querySelectorAll('#sndRows select'),function(sel){
    var ev=sel.getAttribute('data-e'),h='<option value="">Default voice</option>';
    lib.packs.forEach(function(p){
      if(p.explicit&&opts.clean)return;
      h+='<optgroup label="'+W.esc(p.title)+'">';
      p.clips.forEach(function(c){h+='<option value="L:'+c.id+'">'+W.esc(c.n)+'</option>'});
      h+='</optgroup>';
    });
    if(custom[ev])h+='<option value="C">My file: '+W.esc(ls('ng_cn_'+ev)||'uploaded')+'</option>';
    h+='<option value="U">Upload my own…</option>';
    sel.innerHTML=h;
    sel.value=map[ev]||'';if(sel.value!==(map[ev]||''))sel.value='';
  });
}
function buildSound(){
  var h='';
  G.ev.forEach(function(e){h+='<div class="srow"><span>'+e[1]+'</span><select class="sel" data-e="'+e[0]+'" aria-label="'+e[1]+'"></select><button class="ghost" data-p="'+e[0]+'">Play</button><input type="file" accept="audio/*" hidden data-f="'+e[0]+'"></div>'});
  $('sndRows').innerHTML=h;fillSelects();
  Array.prototype.forEach.call($('sndRows').querySelectorAll('select'),function(sel){sel.onchange=function(){
    var ev=sel.getAttribute('data-e');
    if(sel.value==='U'){sel.value=map[ev]||'';$('sndRows').querySelector('[data-f="'+ev+'"]').click();return}
    map[ev]=sel.value;saveMap();sendPrefs();if(sel.value)preview(ev);
  }});
  Array.prototype.forEach.call($('sndRows').querySelectorAll('button'),function(b){b.onclick=function(){preview(b.getAttribute('data-p'))}});
  Array.prototype.forEach.call($('sndRows').querySelectorAll('input'),function(inp){inp.onchange=function(){
    var f=inp.files[0],ev=inp.getAttribute('data-f');if(!f)return;
    var r=new FileReader();r.onload=function(){custom[ev]=r.result;ls('ng_c_'+ev,r.result);ls('ng_cn_'+ev,f.name.slice(0,24));map[ev]='C';saveMap();fillSelects();sendPrefs();preview(ev)};r.readAsDataURL(f);
  }});
}
function loadLib(){
  var x=new XMLHttpRequest();x.open('GET','/api/sounds');
  x.onload=function(){try{lib=JSON.parse(x.responseText)}catch(e){return}idx={};lib.packs.forEach(function(p){p.clips.forEach(function(c){idx[c.id]={explicit:p.explicit}})});fillSelects()};
  x.send();
}
function loadPrefs(){
  try{opts=Object.assign(opts,JSON.parse(ls('ng_opts')||'{}'));map=JSON.parse(ls('ng_map')||'{}')}catch(e){}
  G.ev.forEach(function(e){var c=ls('ng_c_'+e[0]);if(c)custom[e[0]]=c});
  [['oVoice','voice'],['oOthers','others'],['oClean','clean'],['oMute','mute']].forEach(function(o){
    var el=$(o[0]);el.checked=!!opts[o[1]];el.onchange=function(){opts[o[1]]=el.checked;ls('ng_opts',JSON.stringify(opts));fillSelects()};
  });
}

/* ---------- interface ---------- */
function ui(){
  var dsel=G.dice?'<div class="dsel"><span>Dice:</span><button class="ghost" data-n="1">1 die</button><button class="ghost" data-n="2">2 dice</button></div>':'';
  document.body.insertAdjacentHTML('beforeend',
  '<div class="ov on" id="startOv"><div class="box" style="max-width:380px"><h2>'+G.title+'</h2><p>Play online with friends. Everyone opens this page on their own device.</p>'+
  '<input class="fld" id="nick" maxlength="12" placeholder="Your name" aria-label="Your name"><button class="go2" id="mkBtn" disabled>Create room</button>'+
  '<div class="sm2">or join a friend’s room</div><div class="row2"><input class="fld" id="code" maxlength="4" placeholder="CODE" aria-label="Room code" style="text-transform:uppercase"><button class="ghost" id="joinBtn" disabled>Join</button></div>'+
  '<div class="sm2" id="entMsg" style="color:#8a1c16">Connecting…</div><a class="sm2" href="/" style="color:#5b6b5f">All games</a></div></div>'+
  '<div class="ov" id="roomOv"><div class="box" style="max-width:380px"><h2>Room <span id="rcode"></span></h2><p>Share this code. Friends open this game and tap Join.</p><div id="plist"></div><div class="sm2" id="rmsg"></div>'+
  dsel+'<div id="hostBtns"><button class="ghost" id="addBot">Add computer</button> <button class="go2" id="startBtn">Start game</button></div><button class="ghost" id="leaveBtn" style="margin-top:10px">Leave</button></div></div>'+
  '<div class="ov" id="endOv"><div class="box"><div class="trophy" id="trophy" aria-hidden="true"><svg viewBox="0 0 64 64"><path d="M18 8h28v14c0 9-6 16-14 16S18 31 18 22z" fill="#f2b705" stroke="#b36100" stroke-width="2"/><path d="M18 12H8c0 10 4 16 12 18M46 12h10c0 10-4 16-12 18" fill="none" stroke="#b36100" stroke-width="3"/><rect x="28" y="38" width="8" height="10" fill="#d99a00"/><rect x="20" y="48" width="24" height="8" rx="2" fill="#b36100"/><path d="M24 12v10" stroke="#fff" stroke-width="3" opacity=".6" stroke-linecap="round"/></svg></div><h2 id="endMsg"></h2><p id="endSub"></p>'+dsel+'<button class="ghost" id="again">Rematch</button> <button class="ghost" id="leaveEnd">Leave</button></div></div>'+
  '<div class="ov" id="sndOv"><div class="box" style="max-width:440px;text-align:left"><h2>Sounds</h2><p>Pick a sound for each moment or upload your own. Everyone hears the library sound chosen by the player who triggers the moment.</p><div id="sndRows"></div>'+
  '<label class="opt"><input type="checkbox" id="oVoice"> Voice-over when no sound is set</label><label class="opt"><input type="checkbox" id="oOthers"> Hear other players’ library sounds</label>'+
  '<label class="opt"><input type="checkbox" id="oClean"> Clean mode (hide explicit packs)</label><label class="opt"><input type="checkbox" id="oMute"> Mute everything</label>'+
  '<button class="ghost" id="sndClose" style="margin-top:6px">Done</button></div></div>');
}
W.chance=function(ws){
  var t=ws.reduce(function(a,b){return a+b},0),r=ws.map(function(w){return t?w/t*100:100/ws.length}),f=r.map(Math.floor),rem=100-f.reduce(function(a,b){return a+b},0);
  r.map(function(v,i){return{i:i,d:v-f[i]}}).sort(function(a,b){return b.d-a.d}).slice(0,rem).forEach(function(o){f[o.i]++});
  return f;
};
W.bars=function(id,rows){
  var el=$(id);if(!el)return;var h='<div class="cbt">Win chance</div>';
  rows.forEach(function(r){h+='<div class="cb" title="'+W.esc(r.t||'')+'"><span class="cn">'+W.esc(r.n)+'</span><div class="bar"><i style="width:'+r.p+'%;background:'+r.c+'"></i></div><b>'+r.p+'%</b></div>'});
  el.innerHTML=h;
};
W.confetti=function(){
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  var c=document.createElement('canvas');c.className='confetti';c.width=innerWidth;c.height=innerHeight;
  var x=c.getContext&&c.getContext('2d');if(!x)return;
  document.body.appendChild(c);
  var cols=['#f2b705','#d32f2f','#1b8f4b','#1e63c6','#ffffff','#e91e63'],P=[],t0=Date.now();
  function add(n){for(var i=0;i<n;i++)P.push({x:Math.random()*c.width,y:-12,vx:(Math.random()-.5)*2.4,vy:2+Math.random()*3.5,r:4+Math.random()*5,a:Math.random()*6,va:(Math.random()-.5)*.3,col:cols[Math.floor(Math.random()*cols.length)]})}
  add(120);
  (function f(){
    var el=Date.now()-t0;x.clearRect(0,0,c.width,c.height);
    if(el<2600)add(4);
    P.forEach(function(p){p.x+=p.vx;p.y+=p.vy;p.a+=p.va;x.save();x.translate(p.x,p.y);x.rotate(p.a);x.fillStyle=p.col;x.fillRect(-p.r,-p.r/2,p.r*2,p.r);x.restore()});
    P=P.filter(function(p){return p.y<c.height+20});
    if(el<6500&&(P.length||el<2600))requestAnimationFrame(f);else c.remove();
  })();
};
function setDice(n){W.dice=n;Array.prototype.forEach.call(document.querySelectorAll('.dsel button'),function(b){b.classList.toggle('on',+b.getAttribute('data-n')===n);b.disabled=!W.isHost})}
W.showEnd=function(title,sub,me){
  $('trophy').className='trophy'+(me?' me':'');W.confetti();
  $('endMsg').textContent=title;$('endSub').textContent=sub||(W.isHost?'Start another round?':'Waiting for the host to start a rematch.');
  $('again').style.display=W.isHost?'':'none';$('endOv').classList.add('on');
};
function renderRoom(m){
  var h='';m.list.forEach(function(p,i){h+='<div class="srow"><span>'+W.esc(p.n)+(p.h?' (host)':'')+(i===m.me?' (you)':'')+'</span></div>'});
  for(var k=1;k<=m.bots;k++)h+='<div class="srow"><span>Computer '+k+'</span></div>';
  $('plist').innerHTML=h;var total=m.list.length+m.bots;
  $('hostBtns').style.display=m.host?'':'none';$('startBtn').disabled=total<2;$('addBot').disabled=total>=4;
  $('rmsg').textContent=m.host?(total<2?'Waiting for at least one more player…':''):'Waiting for the host to start…';
}
function saved(){try{return JSON.parse(sessionStorage.getItem('ng_s'))}catch(e){return null}}
function enable(on){$('mkBtn').disabled=!on;$('joinBtn').disabled=!on}
function nm(){var n=($('nick').value.trim()||'Player').slice(0,12);ls('ng_nick',n);return n}
function resetLocal(){
  W.isHost=false;G.reset();
  ['roomOv','endOv'].forEach(function(id){$(id).classList.remove('on')});
  $('startOv').classList.add('on');if($('score'))$('score').textContent='';
}
function leave(){W.send({t:'leave'});try{sessionStorage.removeItem('ng_s')}catch(e){}resetLocal()}
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);
  ws.onopen=function(){retry=0;enable(true);var ss=saved();if(ss&&ss.code&&ss.pid)W.send({t:'rejoin',code:ss.code,pid:ss.pid});else $('entMsg').textContent='';sendPrefs()};
  ws.onmessage=function(e){var m;try{m=JSON.parse(e.data)}catch(x){return}onMsg(m)};
  ws.onclose=function(){enable(false);$('entMsg').textContent=saved()?'Connection lost. Reconnecting…':'Connecting…';setTimeout(connect,Math.min(4000,700*(++retry)))};
}
function onMsg(m){
  if(m.t==='joined'){
    try{sessionStorage.setItem('ng_s',JSON.stringify({code:m.code,pid:m.pid}))}catch(e){}
    if(m.game&&m.game!==G.game){location.href='/'+m.game+'.html';return}
    $('entMsg').textContent='';sendPrefs();
  }else if(m.t==='lobby'){
    W.isHost=m.host;if(m.dice)setDice(m.dice);$('rcode').textContent=m.code;if($('score'))$('score').textContent='Room '+m.code;
    if(!G.inGame()){$('startOv').classList.remove('on');$('roomOv').classList.add('on');renderRoom(m)}
  }else if(m.t==='state'){
    W.isHost=!!m.host;if(m.nd)setDice(m.nd);$('roomOv').classList.remove('on');$('startOv').classList.remove('on');G.onState(m);
  }else if(m.t==='hand'){if(G.onHand)G.onHand(m)}
  else if(m.t==='err'){
    if(m.expired){try{sessionStorage.removeItem('ng_s')}catch(e){}resetLocal()}
    $('entMsg').textContent=m.msg;
  }
}
W.init=function(g){
  G=g;ui();loadPrefs();buildSound();loadLib();
  try{$('nick').value=ls('ng_nick')||''}catch(e){}
  $('mkBtn').onclick=function(){$('entMsg').textContent='';W.send({t:'create',game:G.game,name:nm()})};
  $('joinBtn').onclick=function(){
    var c=$('code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(c.length!==4){$('entMsg').textContent='Enter the 4-character room code.';return}
    $('entMsg').textContent='';W.send({t:'join',code:c,name:nm()});
  };
  $('addBot').onclick=function(){W.send({t:'addbot'})};
  $('startBtn').onclick=function(){W.send({t:'start'})};
  $('again').onclick=function(){W.send({t:'start'})};
  ['leaveBtn','leaveEnd','leaveTop'].forEach(function(id){if($(id))$(id).onclick=leave});
  if($('sndBtn'))$('sndBtn').onclick=function(){$('sndOv').classList.add('on')};
  Array.prototype.forEach.call(document.querySelectorAll('.dsel button'),function(b){b.onclick=function(){W.send({t:'setdice',n:+b.getAttribute('data-n')})}});
  $('sndClose').onclick=function(){$('sndOv').classList.remove('on')};
  connect();
};
})();
