/* Shared shell for every game page: connection, lobby, end screen and the sound system. */
(function(){
var W=window.W={},G=null,ws=null,retry=0,rejoining=false,opts={voice:true,mute:false,muteChat:false,turnBell:true,others:true,clean:false},map={},custom={},lib={packs:[]},idx={};
var APP_VERSION='1.0.0',audioCtx=null,turnSeq=-1,wasMyTurn=false,turnDeadline=0,turnTotal=0,turnReminded=false,turnData=null,turnTick=null,chatUnread=0,chatOpen=false,mySeat=-1;
var rtts=[],feedbackGame=null,feedbackCooldown=null,feedbackPending=false,activeNotice=null,pingTimer=null;
var $=W.$=function(id){return document.getElementById(id)};
W.esc=function(t){return String(t).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
W.isHost=false;
function ls(k,v){try{if(v===undefined)return localStorage.getItem(k);if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v)}catch(e){}return null}
W.send=function(o){if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))};
W.open=function(){return !!ws&&ws.readyState===1};

/* ---------- sounds ---------- */
function prepareAudio(){
  if(audioCtx)return;
  var AC=window.AudioContext||window.webkitAudioContext;
  if(AC)try{audioCtx=new AC()}catch(e){}
}
['pointerdown','keydown','touchstart'].forEach(function(ev){document.addEventListener(ev,prepareAudio,{once:true,capture:true})});
function tone(freq,when,duration,volume,type){
  if(!audioCtx)return;
  var osc=audioCtx.createOscillator(),gain=audioCtx.createGain();
  osc.type=type||'sine';osc.frequency.setValueAtTime(freq,when);
  gain.gain.setValueAtTime(volume,when);gain.gain.exponentialRampToValueAtTime(.001,when+duration);
  osc.connect(gain);gain.connect(audioCtx.destination);osc.start(when);osc.stop(when+duration);
}
function bell(soft){
  if(!audioCtx)return;
  if(audioCtx.state==='suspended')audioCtx.resume().catch(function(){});
  var now=audioCtx.currentTime,vol=soft ? .16 : .38;
  tone(880,now,.8,vol,'sine');tone(1320,now,.68,vol*.48,'sine');
}
function tickSound(){
  if(!audioCtx||opts.mute||opts.muteChat)return;
  if(audioCtx.state==='suspended')audioCtx.resume().catch(function(){});
  tone(1050,audioCtx.currentTime,.075,.035,'sine');
}
function speak(t){if(!opts.voice||opts.mute||!window.speechSynthesis||!t)return;try{speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance(t))}catch(e){}}
W.fire=function(ev,text,sid,soft){
  if(opts.mute)return;
  var url=null,m=map[ev];
  if(sid&&opts.others&&idx[sid]&&!(idx[sid].explicit&&opts.clean))url='/sounds/'+sid;
  else if(m&&m.indexOf('L:')===0&&idx[m.slice(2)]&&!(idx[m.slice(2)].explicit&&opts.clean))url='/sounds/'+m.slice(2);
  else if(m==='C'&&custom[ev])url=custom[ev];
  if(url){try{var a=new Audio(url);if(ev==='turn'&&soft)a.volume=.35;a.play().catch(function(){})}catch(e){}}
  else if(ev==='turn')bell(!!soft);
  else speak(text);
};
var baseTitle=document.title,titleBlink=null;
function stopTitleBlink(){if(titleBlink){clearInterval(titleBlink);titleBlink=null}document.title=baseTitle}
function alertTurn(soft){
  if(opts.turnBell&&!opts.mute){W.fire('turn','Your turn',null,soft);if(!soft&&navigator.vibrate)navigator.vibrate([120,60,120])}
  if(soft)return;
  if(document.hidden){
    var reduceMotion=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(!titleBlink&&!reduceMotion){var show=false;titleBlink=setInterval(function(){show=!show;document.title=show?'Your turn! - Naija Games':baseTitle},750)}
    if('Notification'in window&&Notification.permission==='granted'){
      try{var n=new Notification('Your turn! - Naija Games',{body:'It is your turn to play.'});n.onclick=function(){window.focus();n.close()}}catch(e){}
    }
  }
}
document.addEventListener('visibilitychange',function(){if(!document.hidden)stopTitleBlink()});
function drawTurnTimer(d){
  var box=$('turnTimer');if(!box)return;
  if(!box.querySelector('.turnText')){
    var text=document.createElement('span'),bar=document.createElement('div'),fill=document.createElement('i');
    text.className='turnText';bar.className='turnBar';bar.appendChild(fill);box.appendChild(text);box.appendChild(bar);
  }
  if(!turnDeadline||!d||d.over||d.tl===null){box.hidden=true;return}
  var left=Math.max(0,turnDeadline-Date.now()),seconds=Math.ceil(left/1000),mine=d.turn===d.me;
  box.hidden=false;box.classList.toggle('urgent',left<=10000);
  box.querySelector('.turnText').textContent=mine?'Your turn ('+seconds+'s)':'Waiting for '+(d.seats[d.turn]&&d.seats[d.turn].n||'player')+' ('+seconds+'s)';
  box.querySelector('.turnBar i').style.width=(turnTotal?Math.max(0,Math.min(100,left/turnTotal*100)):0)+'%';
}
function stopTurnClock(){if(turnTick){clearInterval(turnTick);turnTick=null}}
function startTurnClock(){if(!turnTick)turnTick=setInterval(turnClock,250)}
W.updateTurn=function(d,snapshot){
  if(!d||!Number.isFinite(d.seq)||d.seq<turnSeq)return;
  if(d.seq===turnSeq){
    if(snapshot){
      turnData=d;turnDeadline=d.tl===null||d.tl===undefined?0:Date.now()+d.tl;turnTotal=Math.max(1,d.tl||0);
      turnReminded=d.tl!==null&&d.tl!==undefined&&d.tl<=10000;wasMyTurn=d.turn===d.me&&!d.over;
      if(turnDeadline)startTurnClock();else stopTurnClock();
    }
    drawTurnTimer(turnData||d);return;
  }
  turnData=d;
  var mine=d.turn===d.me&&!d.over;
  if(d.tl===null||d.tl===undefined){turnDeadline=0;turnTotal=0;turnReminded=true;stopTurnClock()}
  else{turnDeadline=Date.now()+d.tl;turnTotal=Math.max(1,d.tl);turnReminded=!!snapshot&&d.tl<=10000;startTurnClock()}
  if(snapshot)wasMyTurn=mine;
  else{
    if(mine&&!wasMyTurn&&(turnSeq>=0||(d.last&&d.last.t==='start')))alertTurn(false);
    wasMyTurn=mine;
  }
  turnSeq=d.seq;drawTurnTimer(d);
};
W.resetTurn=function(){stopTurnClock();turnSeq=-1;wasMyTurn=false;turnDeadline=0;turnTotal=0;turnReminded=false;turnData=null;drawTurnTimer(null)};
function turnClock(){
  if(turnDeadline){
    var left=turnDeadline-Date.now();
    if(!turnReminded&&turnTotal>10000&&left<=10000){turnReminded=true;alertTurn(true)}
    if(turnData)drawTurnTimer(turnData);
    if(left<=0)stopTurnClock();
  }
}
function saveMap(){ls('ng_map',JSON.stringify(map))}
function sendPrefs(){var s={};for(var e in map)if(map[e]&&map[e].indexOf('L:')===0)s[e]=map[e].slice(2);W.send({t:'prefs',s:s})}
function preview(ev){var m=opts.mute;opts.mute=false;var t=G.ev.filter(function(e){return e[0]===ev})[0];W.fire(ev,t?t[2]:'',null);opts.mute=m}
function fillSelects(){
  Array.prototype.forEach.call(document.querySelectorAll('#sndRows select'),function(sel){
    var ev=sel.getAttribute('data-e'),h='<option value="">'+(ev==='turn'?'Default bell':'Default voice')+'</option>';
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
  [['oVoice','voice'],['oOthers','others'],['oClean','clean'],['oMute','mute'],['oMuteChat','muteChat'],['oTurnBell','turnBell']].forEach(function(o){
    var el=$(o[0]);el.checked=!!opts[o[1]];el.onchange=function(){opts[o[1]]=el.checked;ls('ng_opts',JSON.stringify(opts));fillSelects()};
  });
}
function chatEntry(m){
  var list=$('chatMessages');if(!list)return;
  var stick=list.scrollHeight-list.scrollTop-list.clientHeight<36;
  var row=document.createElement('div'),meta=document.createElement('div'),body=document.createElement('div');
  row.className='chatMessage'+(m.seat===mySeat?' own':'');
  meta.className='chatMeta';meta.textContent=String(m.from||'Player')+(m.ts?' · '+new Date(m.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'');
  body.className='chatText';body.textContent=String(m.text||'');
  row.appendChild(meta);row.appendChild(body);list.appendChild(row);
  while(list.children.length>50)list.removeChild(list.firstChild);
  if(chatOpen&&stick)list.scrollTop=list.scrollHeight;
}
function setUnread(n){
  chatUnread=n;var b=$('chatBadge');if(!b)return;
  b.textContent=n>99?'99+':String(n);b.hidden=!n;
  var f=$('chatFab');if(f)f.setAttribute('aria-label',n?'Open chat, '+n+' unread messages':'Open chat');
}
function showChat(open){
  chatOpen=!!open;$('chatPanel').classList.toggle('open',chatOpen);$('chatFab').setAttribute('aria-expanded',chatOpen?'true':'false');
  if(chatOpen){setUnread(0);$('chatInput').focus();$('chatMessages').scrollTop=$('chatMessages').scrollHeight}
}
function sendChat(text){
  var value=String(text||'').trim();if(!value)return;
  W.send({t:'chat',text:value});$('chatInput').value='';$('chatError').textContent='';
}
function drawChatLog(list){
  var box=$('chatMessages');if(!box)return;box.textContent='';
  (Array.isArray(list)?list:[]).slice(-50).forEach(chatEntry);
  box.scrollTop=box.scrollHeight;
}
var feedbackQuestions=[['ux','User experience'],['responsiveness','Responsiveness'],['latency','Latency'],['features','Features'],['speed','Speed'],['entertainment','Entertainment']];
function feedbackMarkup(){
  if($('feedbackOv'))return;
  var fields=feedbackQuestions.map(function(q){
    return '<fieldset class="rating"><legend>'+q[1]+' <span aria-hidden="true">*</span></legend><div class="stars" role="radiogroup" aria-label="'+q[1]+'">'+[1,2,3,4,5].map(function(n){
      return '<label class="starOpt" aria-label="'+n+' out of 5"><input type="radio" name="'+q[0]+'" value="'+n+'" required><span aria-hidden="true">★</span></label>';
    }).join('')+'</div></fieldset>';
  }).join('');
  document.body.insertAdjacentHTML('beforeend',
    '<div class="ov" id="feedbackOv"><div class="box feedbackBox"><button class="ghost feedbackX" id="feedbackX" type="button" aria-label="Close feedback">Close</button>'+
    '<h2>Help us improve Naija Games</h2><p>Your name and answers are saved so we can improve the app.</p>'+
    '<form id="feedbackForm"><label class="feedbackName">Username<input class="fld" name="username" maxlength="12" required></label>'+
    fields+'<fieldset class="rating"><legend>Would you use voice chat while playing? <span aria-hidden="true">*</span></legend>'+
    '<label class="voiceOpt"><input type="radio" name="voice" value="yes" required> Yes</label><label class="voiceOpt"><input type="radio" name="voice" value="no" required> No</label><label class="voiceOpt"><input type="radio" name="voice" value="maybe" required> Maybe</label></fieldset>'+
    '<label class="feedbackName">Comment (optional)<textarea class="fld" name="comment" maxlength="500" rows="4"></textarea></label><div class="feedbackCount"><span id="feedbackCount">0</span>/500</div>'+
    '<div class="feedbackMsg" id="feedbackMsg" role="status"></div><button class="go2" id="feedbackSubmit" type="submit">Send feedback</button></form></div></div>');
  $('feedbackX').onclick=closeFeedback;
  $('feedbackForm').onsubmit=function(e){e.preventDefault();submitFeedback()};
  $('feedbackForm').elements.comment.oninput=function(){$('feedbackCount').textContent=String(this.value.length)};
  Array.prototype.forEach.call(document.querySelectorAll('[data-feedback]'),function(b){b.onclick=function(){openFeedback(G&&G.game||'menu')}});
}
function openFeedback(game){
  feedbackMarkup();feedbackGame=game||'menu';
  var form=$('feedbackForm');form.reset();form.elements.username.value=String(ls('ng_nick')||'').slice(0,12);
  $('feedbackCount').textContent='0';$('feedbackMsg').textContent='';
  if(feedbackPending){$('feedbackSubmit').disabled=true;$('feedbackMsg').textContent='Sending feedback…'}
  var since=Number(ls('ng_fb_at')||0),left=60000-(Date.now()-since);
  if(!feedbackPending)$('feedbackSubmit').disabled=left>0;
  if(!feedbackPending&&left>0){
    $('feedbackMsg').textContent='Thanks for your feedback. You can submit again in '+Math.ceil(left/1000)+' seconds.';
    clearInterval(feedbackCooldown);feedbackCooldown=setInterval(function(){left=60000-(Date.now()-since);if(left<=0){clearInterval(feedbackCooldown);feedbackCooldown=null;$('feedbackSubmit').disabled=false;$('feedbackMsg').textContent=''}else $('feedbackMsg').textContent='Thanks for your feedback. You can submit again in '+Math.ceil(left/1000)+' seconds.'},1000);
  }
  $('feedbackOv').classList.add('on');
}
function closeFeedback(){$('feedbackOv').classList.remove('on')}
function clientId(){
  var id=ls('ng_cid');if(id)return id;
  try{id=crypto.randomUUID()}catch(e){id=''}
  if(!id)id='ng-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
  ls('ng_cid',id);return id;
}
function submitFeedback(){
  var form=$('feedbackForm'),username=form.elements.username.value.trim();
  var ratings={};feedbackQuestions.forEach(function(q){var v=form.elements[q[0]].value;ratings[q[0]]=Number(v)});
  if(feedbackPending||!W.open()){ $('feedbackMsg').textContent='Connect to the game server before sending feedback.';return }
  if(!username||username.length>12||!form.elements.voice.value||feedbackQuestions.some(function(q){return !Number.isInteger(ratings[q[0]])||ratings[q[0]]<1||ratings[q[0]]>5})){
    $('feedbackMsg').textContent='Enter a username and choose a star rating for each category.';return;
  }
  var voice=form.elements.voice.value,comment=form.elements.comment.value.trim();
  feedbackPending=true;$('feedbackSubmit').disabled=true;
  W.send({t:'feedback',client_id:clientId(),username:username,game:feedbackGame||'menu',
    device:(matchMedia&&matchMedia('(pointer: coarse)').matches)||innerWidth<768?'mobile':'desktop',
    rtt_ms:rtts.length?Math.round(rtts.reduce(function(a,b){return a+b},0)/rtts.length):null,
    ux:ratings.ux,responsiveness:ratings.responsiveness,latency:ratings.latency,features:ratings.features,
    speed:ratings.speed,entertainment:ratings.entertainment,voice:voice,comment:comment,app_version:APP_VERSION});
  $('feedbackMsg').textContent='Sending feedback…';
}
function feedbackAccepted(){
  feedbackPending=false;ls('ng_fb_at',String(Date.now()));
  $('feedbackSubmit').disabled=true;$('feedbackMsg').textContent='Thank you for helping us improve Naija Games.';
}
W.feedbackOnly=function(){
  G={game:'menu',ev:[]};
  var button=document.createElement('button');button.type='button';button.className='feedback-menu-button';button.textContent='Feedback';
  button.setAttribute('data-feedback','');document.body.appendChild(button);feedbackMarkup();connect();
};
function sendHello(){
  var name=String(ls('ng_nick')||'Player').trim().slice(0,12)||'Player';
  W.send({t:'hello',cid:clientId(),name:name});
}
function startPing(){
  clearInterval(pingTimer);pingTimer=setInterval(function(){
    if(ws&&ws.readyState===1)W.send({t:'ping',ts:Date.now(),rtt_ms:rtts.length?Math.round(rtts.reduce(function(a,b){return a+b},0)/rtts.length):null});
  },10000);
}
function showNotice(text){
  activeNotice=String(text||'');
  var box=$('noticeBanner');if(!box)return;
  box.textContent='';var msg=document.createElement('span'),close=document.createElement('button');
  msg.textContent=activeNotice;close.type='button';close.className='ghost';close.textContent='Dismiss';
  close.onclick=function(){box.hidden=true};box.appendChild(msg);box.appendChild(close);box.hidden=false;
}

/* ---------- interface ---------- */
function ui(){
  var dsel=G.dice?'<div class="dsel"><span>Dice:</span><button class="ghost" data-n="1">1 die</button><button class="ghost" data-n="2">2 dice</button></div>':'';
  document.body.classList.add('chat-enabled');
  document.body.insertAdjacentHTML('beforeend',
  '<div class="ov on" id="startOv"><div class="box" style="max-width:380px"><h2>'+G.title+'</h2><p>Play online with friends. Everyone opens this page on their own device.</p>'+
  '<input class="fld" id="nick" maxlength="12" placeholder="Your name" aria-label="Your name"><button class="go2" id="mkBtn" disabled>Create room</button>'+
  '<div class="sm2">or join a friend’s room</div><div class="row2"><input class="fld" id="code" maxlength="4" placeholder="CODE" aria-label="Room code" style="text-transform:uppercase"><button class="ghost" id="joinBtn" disabled>Join</button></div>'+
  '<div class="sm2" id="entMsg" style="color:#8a1c16">Connecting…</div><a class="sm2" href="/" style="color:#5b6b5f">All games</a></div></div>'+
  '<div class="ov" id="roomOv"><div class="box" style="max-width:380px"><h2>Room <span id="rcode"></span></h2><p>Share this code. Friends open this game and tap Join.</p><div id="plist"></div><div class="sm2" id="rmsg"></div>'+
  dsel+'<div id="hostBtns"><button class="ghost" id="addBot">Add computer</button> <button class="go2" id="startBtn">Start game</button></div><a class="ghost inviteBtn" id="inviteBtn" target="_blank" rel="noopener">Invite on WhatsApp</a><button class="ghost" id="leaveBtn" style="margin-top:10px">Leave</button></div></div>'+
  '<div class="ov" id="endOv"><div class="box"><div class="trophy" id="trophy" aria-hidden="true"><svg viewBox="0 0 64 64"><path d="M18 8h28v14c0 9-6 16-14 16S18 31 18 22z" fill="#f2b705" stroke="#b36100" stroke-width="2"/><path d="M18 12H8c0 10 4 16 12 18M46 12h10c0 10-4 16-12 18" fill="none" stroke="#b36100" stroke-width="3"/><rect x="28" y="38" width="8" height="10" fill="#d99a00"/><rect x="20" y="48" width="24" height="8" rx="2" fill="#b36100"/><path d="M24 12v10" stroke="#fff" stroke-width="3" opacity=".6" stroke-linecap="round"/></svg></div><h2 id="endMsg"></h2><p id="endSub"></p>'+dsel+'<button class="ghost" id="again">Rematch</button> <button class="ghost" id="leaveEnd">Leave</button> <button class="ghost" type="button" data-feedback>Feedback</button></div></div>'+
  '<div class="ov" id="sndOv"><div class="box" style="max-width:440px;text-align:left"><h2>Sounds</h2><p>Pick a sound for each moment or upload your own. Everyone hears the library sound chosen by the player who triggers the moment.</p><div id="sndRows"></div>'+
  '<label class="opt"><input type="checkbox" id="oVoice"> Voice-over when no sound is set</label><label class="opt"><input type="checkbox" id="oOthers"> Hear other players’ library sounds</label>'+
  '<label class="opt"><input type="checkbox" id="oClean"> Clean mode (hide explicit packs)</label><label class="opt"><input type="checkbox" id="oMute"> Mute everything</label>'+
  '<label class="opt"><input type="checkbox" id="oMuteChat"> Mute chat</label><label class="opt"><input type="checkbox" id="oTurnBell"> Turn bell</label>'+
  '<button class="ghost notifyBtn" id="notifyBtn" type="button">Allow notifications</button> <span class="sm2" id="notifyStatus"></span>'+
  '<button class="ghost" id="sndClose" style="margin-top:6px">Done</button></div></div>'+
  '<div class="noticeBanner" id="noticeBanner" role="status" hidden></div>'+
  '<button class="chatFab" id="chatFab" type="button" aria-label="Open chat" aria-expanded="false">Chat <span id="chatBadge" hidden>0</span></button>'+
  '<section class="chatPanel" id="chatPanel" aria-label="Room chat"><header class="chatHead"><b>Room chat</b><button class="ghost" id="chatClose" type="button">Close</button></header>'+
  '<div class="chatMessages" id="chatMessages" aria-live="polite" aria-relevant="additions"></div>'+
  '<div class="chatQuick" aria-label="Quick replies">'+['Good game','Hurry up','Oya play!','Haba!','Well played'].map(function(t){return '<button type="button" class="quickReply">'+W.esc(t)+'</button>'}).join('')+'</div>'+
  '<div class="chatReactions" aria-label="Emoji reactions">'+['👍','❤️','😂','😮','👏'].map(function(t){return '<button type="button" class="reactionReply" aria-label="React '+W.esc(t)+'">'+W.esc(t)+'</button>'}).join('')+'</div>'+
  '<form class="chatForm" id="chatForm"><input id="chatInput" maxlength="140" autocomplete="off" placeholder="Write a message…" aria-label="Chat message"><button type="submit">Send</button></form><div class="chatError" id="chatError" role="status"></div></section>');
  feedbackMarkup();
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
  var invite='Join my game: '+location.origin+'/'+G.game+'.html, room code '+m.code;
  $('inviteBtn').href='https://wa.me/?text='+encodeURIComponent(invite);
}
function saved(){try{return JSON.parse(sessionStorage.getItem('ng_s'))}catch(e){return null}}
function enable(on){$('mkBtn').disabled=!on;$('joinBtn').disabled=!on}
function nm(){var n=($('nick').value.trim()||'Player').slice(0,12);ls('ng_nick',n);return n}
function resetLocal(){
  W.isHost=false;G.reset();
  document.body.classList.remove('has-room');
  ['roomOv','endOv'].forEach(function(id){$(id).classList.remove('on')});
  $('startOv').classList.add('on');if($('score'))$('score').textContent='';
  W.resetTurn();showChat(false);setUnread(0);
}
function leave(){W.send({t:'leave'});try{sessionStorage.removeItem('ng_s')}catch(e){}resetLocal()}
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);
  ws.onopen=function(){
    retry=0;sendHello();startPing();
    if(G.game==='menu')return;
    enable(true);var ss=saved();if(ss&&ss.code&&ss.pid){rejoining=true;W.send({t:'rejoin',code:ss.code,pid:ss.pid})}else{$('entMsg').textContent='';rejoining=false}sendPrefs();
  };
  ws.onmessage=function(e){var m;try{m=JSON.parse(e.data)}catch(x){return}onMsg(m)};
  ws.onclose=function(){clearInterval(pingTimer);if(G.game!=='menu'){enable(false);$('entMsg').textContent=saved()?'Connection lost. Reconnecting…':'Connecting…'}setTimeout(connect,Math.min(4000,700*(++retry)))};
}
function onMsg(m){
  if(m.t==='pong'&&Number.isSafeInteger(m.ts)){
    var rtt=Math.max(0,Date.now()-m.ts);rtts.push(Math.min(60000,rtt));if(rtts.length>10)rtts.shift();return;
  }
  if(m.t==='feedback_ok'){feedbackAccepted();return}
  if(m.t==='notice'){showNotice(m.text);return}
  if(G.game==='menu'&&m.t!=='err')return;
  if(m.t==='joined'){
    document.body.classList.add('has-room');
    try{sessionStorage.setItem('ng_s',JSON.stringify({code:m.code,pid:m.pid}))}catch(e){}
    if(m.game&&m.game!==G.game){location.href='/'+m.game+'.html';return}
    $('entMsg').textContent='';sendPrefs();
  }else if(m.t==='lobby'){
    W.isHost=m.host;mySeat=m.me;if(m.dice)setDice(m.dice);$('rcode').textContent=m.code;if($('score'))$('score').textContent='Room '+m.code;
    if(!G.inGame()){$('startOv').classList.remove('on');$('roomOv').classList.add('on');renderRoom(m)}
  }else if(m.t==='state'){
    W.isHost=!!m.host;mySeat=m.me;if(m.nd)setDice(m.nd);$('roomOv').classList.remove('on');$('startOv').classList.remove('on');
    var snapshot=rejoining;rejoining=false;W.updateTurn(m,snapshot);G.onState(m,snapshot);
  }else if(m.t==='hand'){if(G.onHand)G.onHand(m)}
  else if(m.t==='chatlog')drawChatLog(m.list)
  else if(m.t==='chat'){
    chatEntry(m);
    if(m.seat!==mySeat){if(!chatOpen)setUnread(chatUnread+1);tickSound()}
  }else if(m.t==='kicked'){
    try{sessionStorage.removeItem('ng_s')}catch(e){}
    rejoining=false;resetLocal();$('entMsg').textContent=m.reason==='closed'?'This room was closed by an administrator.':'You were removed from the game for being inactive.';
  }
  else if(m.t==='err'){
    if(m.expired){try{sessionStorage.removeItem('ng_s')}catch(e){}resetLocal()}
    if(feedbackPending){feedbackPending=false;$('feedbackSubmit').disabled=false;$('feedbackMsg').textContent=m.msg||'Feedback could not be sent.';return}
    if(m.msg==='Slow down'||String(m.msg).indexOf('Message must be')===0)$('chatError').textContent=m.msg;
    else if($('entMsg'))$('entMsg').textContent=m.msg;
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
  $('notifyBtn').onclick=function(){
    if(!('Notification'in window)){$('notifyStatus').textContent='Notifications are not supported here.';return}
    if(Notification.permission==='granted'){$('notifyStatus').textContent='Notifications are allowed.';return}
    if(Notification.permission==='denied'){$('notifyStatus').textContent='Notifications are blocked in browser settings.';return}
    Notification.requestPermission().then(function(p){$('notifyStatus').textContent=p==='granted'?'Notifications are allowed.':p==='denied'?'Notifications are blocked in browser settings.':'Not enabled.'});
  };
  $('notifyStatus').textContent='Notification'in window&&Notification.permission==='granted'?'Notifications are allowed.':'';
  $('chatFab').onclick=function(){showChat(!chatOpen)};
  $('chatClose').onclick=function(){showChat(false)};
  $('chatForm').onsubmit=function(e){e.preventDefault();sendChat($('chatInput').value)};
  Array.prototype.forEach.call(document.querySelectorAll('.quickReply'),function(b){b.onclick=function(){sendChat(b.textContent)}});
  Array.prototype.forEach.call(document.querySelectorAll('.reactionReply'),function(b){b.onclick=function(){W.send({t:'chat',text:b.textContent,reaction:true})}});
  connect();
};
})();
