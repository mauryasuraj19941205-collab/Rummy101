const express=require("express"),http=require("http"),{WebSocketServer}=require("ws"),path=require("path");
const app=express(),server=http.createServer(app),wss=new WebSocketServer({server});
app.use(express.static(path.join(__dirname,"public")));
const rooms=new Map(),MAX=8,S=["♠","♥","♦","♣"],R=["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const send=(w,x)=>w.readyState===1&&w.send(JSON.stringify(x)),code=()=>Math.random().toString(36).slice(2,8).toUpperCase();
const rv=r=>r==="A"?1:["J","Q","K"].includes(r)?({J:11,Q:12,K:13}[r]):+r;
const pv=r=>["A","J","Q","K"].includes(r)?10:+r;
function deck(){let d=[];for(let k=0;k<2;k++)for(const s of S)for(const r of R)d.push({s,r,id:Math.random()});for(let i=0;i<4;i++)d.push({s:"★",r:"J",id:Math.random()});return d.sort(()=>Math.random()-.5)}
function pure(g){if(g.length<3||g.some(c=>c.s==="★"))return false;let a=g.slice().sort((x,y)=>rv(x.r)-rv(y.r));return new Set(a.map(c=>c.s)).size===1&&a.every((c,i)=>i===0||rv(c.r)===rv(a[i-1].r)+1)}
function seq(g){if(g.length<3)return false;let j=g.filter(c=>c.s==="★").length,a=g.filter(c=>c.s!=="★").sort((x,y)=>rv(x.r)-rv(y.r));if(!a.length||new Set(a.map(c=>c.s)).size!==1)return false;let need=0;for(let i=1;i<a.length;i++){let gap=rv(a[i].r)-rv(a[i-1].r);if(gap<=0)return false;need+=gap-1}return need<=j&&a.length+j>=3}
function set(g){let a=g.filter(c=>c.s!=="★");return g.length>=3&&g.length<=4&&new Set(a.map(c=>c.r)).size===1&&new Set(a.map(c=>c.s)).size===a.length}
function valid(h){if(h.length!==13)return false;function go(rem,groups){if(!rem.length)return groups.filter(seq).length>=2&&groups.some(pure);for(let m=1;m<(1<<rem.length);m++){let n=0;for(let x=m;x;x>>=1)n+=x&1;if(n<3||n>4)continue;let g=[],rest=[];rem.forEach((c,i)=>(m>>i&1?g:rest).push(c));if(seq(g)||set(g)){if(go(rest,groups.concat([g])))return true}}return false}return go(h,[])}
function score(h){return h.reduce((a,c)=>a+(c.s==="★"?0:pv(c.r)),0)}
function pub(r){return{code:r.code,started:r.started,turn:r.turn,round:r.round,players:r.p.map((p,i)=>({seat:i,name:p.name,ready:p.ready,score:p.score,out:p.out,cards:r.started?p.hand.length:0}))}}
function bc(r,x){r.p.forEach(p=>send(p.ws,x))}
function hands(r){r.p.forEach(p=>send(p.ws,{type:"hand",hand:p.hand,canDraw:r.started&&r.p[r.turn]===p}))}
function start(r){r.deck=deck();r.discard=[r.deck.pop()];r.p.forEach(p=>{p.hand=[];p.drawn=false});for(let i=0;i<13;i++)r.p.forEach(p=>p.hand.push(r.deck.pop()));r.turn=0;r.started=true;hands(r);bc(r,{type:"state",state:pub(r)})}
function finishRound(r,winner){r.p.forEach(p=>{if(p===winner)p.score+=0;else p.score+=score(p.hand)});let eliminated=r.p.filter(p=>p.score>=101);eliminated.forEach(p=>p.out=true);bc(r,{type:"round_end",winner:winner.name,scores:r.p.map(p=>({name:p.name,score:p.score,out:p.out}))});if(r.p.filter(p=>!p.out).length<=1){r.started=false;bc(r,{type:"match_end",winner:r.p.find(p=>!p.out)?.name||winner.name});return}r.round++;r.started=false;r.p.forEach(p=>p.ready=false);bc(r,{type:"state",state:pub(r)})}
function next(r){do r.turn=(r.turn+1)%r.p.length;while(r.p[r.turn].out);hands(r);bc(r,{type:"state",state:pub(r)})}
wss.on("connection",ws=>{let r,p;ws.on("message",raw=>{let m;try{m=JSON.parse(raw)}catch{return}
if(m.type==="create"){r={code:code(),p:[],started:false,turn:0,round:1,deck:[],discard:[]};rooms.set(r.code,r);p={name:(m.name||"Player").slice(0,18),ws,ready:false,score:0,out:false,hand:[],drawn:false};r.p.push(p);send(ws,{type:"joined",code:r.code});bc(r,{type:"state",state:pub(r)});return}
if(m.type==="join"){r=rooms.get(String(m.code||"").toUpperCase());if(!r||r.started||r.p.length>=MAX)return send(ws,{type:"error",message:"Room unavailable"});p={name:(m.name||"Player").slice(0,18),ws,ready:false,score:0,out:false,hand:[],drawn:false};r.p.push(p);send(ws,{type:"joined",code:r.code});bc(r,{type:"state",state:pub(r)});return}
if(!r||!p)return;
if(m.type==="ready"){p.ready=!!m.value;if(r.p.filter(x=>!x.out).length>=2&&r.p.filter(x=>!x.out).every(x=>x.ready))start(r);else bc(r,{type:"state",state:pub(r)})}
if(m.type==="draw"&&r.started&&r.p[r.turn]===p&&!p.drawn){if(!r.deck.length){r.deck=r.discard.slice(0,-1).sort(()=>Math.random()-.5);r.discard=[r.discard.at(-1)]}p.hand.push(r.deck.pop());p.drawn=true;send(ws,{type:"hand",hand:p.hand,canDraw:false})}
if(m.type==="discard"&&r.started&&r.p[r.turn]===p&&p.drawn){let i=+m.index;if(i>=0&&i<p.hand.length){r.discard.push(p.hand.splice(i,1)[0]);p.drawn=false;next(r)}}
if(m.type==="declare"&&r.started&&r.p[r.turn]===p&&p.drawn===false){if(valid(p.hand)){finishRound(r,p)}else send(ws,{type:"error",message:"Invalid declaration. Need 2 sequences, including 1 pure sequence."})}
if(m.type==="chat")bc(r,{type:"chat",name:p.name,text:String(m.text||"").slice(0,160)})});
ws.on("close",()=>{if(r&&p){r.p=r.p.filter(x=>x!==p);if(r.p.length)bc(r,{type:"state",state:pub(r)});else rooms.delete(r.code)}})});
server.listen(process.env.PORT||3000);