import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../registrations.js';
import { createApp } from '../app.js';
import { createPoller } from '../poller.js';
import { createSleeper, snapshot, score } from '../sleeper.js';
import { payload, classify, pushPriority } from '../apns.js';
import { config } from '../config.js';
import { estimateTeam, projectedPoints, gameProgress } from '../projections.js';
const T=1800000000;
const cfg={inviteEnabled:true,invite:'a-very-long-test-invite-secret',maxDevices:50,maxActivities:100,perDevice:3,mode:'dry-run'};
const meta={info:{name:'League',season:'2026'},rosters:[{roster_id:1,owner_id:'u1'},{roster_id:2,owner_id:'u2'}],users:[{user_id:'u1',metadata:{team_name:'Rigo FC'}},{user_id:'u2',display_name:'Opponent'}]};
const rows=[{roster_id:1,matchup_id:1,points:10},{roster_id:2,matchup_id:1,points:20}];
const sleeper={matchups:async()=>({rows,updatedAt:T}),meta:async()=>meta};
const registration={leagueId:'123456789',week:6,rosterId:1,pushToken:'aa'.repeat(32),apnsEnvironment:'development',startedAt:T};
function activity(overrides={}) {return {id:'activity-1',deviceId:'d',leagueId:'123456789',week:6,rosterId:1,token:'aa',env:'development',status:'active',version:1,expiresAt:T+28800,startedAt:T,nextAttempt:0,failures:0,force:true,state:{yourScore:0,opponentScore:0,yourProjected:null,opponentProjected:null,yourProjectionKind:'unavailable',opponentProjectionKind:'unavailable',updatedAt:T},...overrides};}
async function fixture(t,options={}){
  const store=openStore(':memory:');const app=createApp({store,sleeper,...options,cfg:{...cfg,...options.cfg},now:options.now??(()=>T*1000)});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  const root=`http://127.0.0.1:${server.address().port}`;
  async function call(path,method='GET',body,token){
    return fetch(root+path,{method,headers:{'content-type':'application/json','x-real-ip':'127.0.0.1',...(token?{authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
  }
  const auth=await (await call('/v1/devices','POST',{inviteCode:cfg.invite})).json();
  return {store,call,root,token:auth.deviceToken};
}

test('SQLite survives close/reopen and rolls back failed mutations',()=>{
  const dir=mkdtempSync(join(tmpdir(),'sleeper-test-'));const file=join(dir,'state.db');
  let s=openStore(file);s.change(d=>d.activities.a=activity());
  assert.throws(()=>s.change(d=>{delete d.activities.a;throw Error('abort');}));s.close();
  s=openStore(file);assert.equal(s.read().activities.a.state.yourScore,0);s.close();rmSync(dir,{recursive:true});
});
test('snapshot names, actual score override, and unavailable estimates',async()=>{
  const snap=await snapshot({rows,updatedAt:T},meta,1,6);
  assert.equal(snap.attributes.yourName,'Rigo FC');assert.equal(snap.state.opponentScore,20);assert.equal(snap.state.yourProjected,null);
  assert.equal(score({points:10,custom_points:0}),0);
  for(const points of [undefined,null,'10',NaN,Infinity])assert.throws(()=>score({points}));
});
test('missing opponents and invalid score data never produce fabricated zero',async()=>{
  await assert.rejects(snapshot({rows:[rows[0]],updatedAt:T},meta,1,6));
  await assert.rejects(snapshot({rows:[{...rows[0],points:null},rows[1]],updatedAt:T},meta,1,6));
});
test('APNs end includes valid state; only Unregistered is terminal',()=>{
  const state=activity().state;
  assert.deepEqual(payload({state,event:'end',timestamp:T}).aps['content-state'],state);
  assert.equal(classify(403,'InvalidProviderToken'),'retry');assert.equal(classify(400,'BadDeviceToken'),'retry');
  assert.equal(classify(410,'Unregistered'),'dead');assert.equal(classify(200),'ok');
});
test('API rejects unauthenticated requests and malformed registrations',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/v1/matchup?leagueId=123456789&week=6&rosterId=1')).status,401);
  assert.equal((await f.call('/v1/activities/activity-1','PUT',{...registration,pushToken:'a'},f.token)).status,400);
  assert.equal((await f.call('/v1/activities/activity-1','PUT',{...registration,startedAt:T-30000},f.token)).status,400);
});
test('concurrent same-ID registration is idempotent, token rotation preserves expiry',async t=>{
  const f=await fixture(t);
  const results=await Promise.all(Array.from({length:5},()=>f.call('/v1/activities/activity-1','PUT',registration,f.token)));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,200,200,200,201]);
  const rotated=await f.call('/v1/activities/activity-1','PUT',{...registration,pushToken:'bb'.repeat(32)},f.token);
  assert.equal(rotated.status,200);const a=f.store.read().activities['activity-1'];assert.equal(a.version,2);assert.equal(a.expiresAt,T+28800);assert.ok(a.state);
});
test('concurrent registrations cannot bypass per-device cap',async t=>{
  const f=await fixture(t,{cfg:{perDevice:1}});
  const responses=await Promise.all([1,2,3].map(i=>f.call(`/v1/activities/activity-${i}`,'PUT',registration,f.token)));
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,429,429]);
});
test('activity ownership, local end, and revoked credentials',async t=>{
  const f=await fixture(t);await f.call('/v1/activities/activity-1','PUT',registration,f.token);
  const other=await(await f.call('/v1/devices','POST',{inviteCode:cfg.invite})).json();
  assert.equal((await f.call('/v1/activities/activity-1','PUT',registration,other.deviceToken)).status,404);
  await f.call('/v1/activities/activity-1','DELETE',null,other.deviceToken);assert.equal(f.store.read().activities['activity-1'].status,'active');
  await f.call('/v1/activities/activity-1','DELETE',null,f.token);assert.equal(f.store.read().activities['activity-1'].token,null);
  assert.equal((await f.call('/v1/activities/activity-1','PUT',registration,f.token)).status,409);
  await f.call('/v1/devices/me','DELETE',null,f.token);assert.equal((await f.call('/v1/activities/activity-1','GET',null,f.token)).status,401);
});
test('same league polling shared, unchanged scores silent, freshness heartbeat sent',async()=>{
  let time=T,calls=0;const sent=[],store=openStore(':memory:');
  store.change(s=>{s.activities.a=activity({id:'a'});s.activities.b=activity({id:'b'});});
  const poll=createPoller({store,sleeper:{...sleeper,matchups:async()=>{calls++;return {rows,updatedAt:time};}},transport:{send:async m=>{sent.push(m);return {kind:'ok'};}},now:()=>time*1000});
  await poll.tick();assert.equal(calls,1);assert.equal(sent.length,2);
  time+=75;await poll.tick();assert.equal(sent.length,2);
  time+=180;await poll.tick();assert.equal(sent.length,4);assert.equal(sent[2].state.updatedAt,time);store.close();
});
test('old-token rejection after rotation cannot end replacement',async()=>{
  const store=openStore(':memory:');store.change(s=>s.activities.a=activity({id:'a'}));
  const poll=createPoller({store,sleeper,now:()=>T*1000,transport:{send:async()=>{
    store.change(s=>{s.activities.a.token='new';s.activities.a.version++;});return {kind:'dead'};
  }}});
  await poll.tick();assert.equal(store.read().activities.a.status,'active');assert.equal(store.read().activities.a.token,'new');store.close();
});
test('expiry before first success sends initial content and stops polling',async()=>{
  const store=openStore(':memory:');store.change(s=>s.activities.a=activity({id:'a',expiresAt:T}));
  const sent=[];let calls=0;
  const poll=createPoller({store,sleeper:{matchups:async()=>{calls++;}},now:()=>T*1000,transport:{send:async m=>{sent.push(m);return {kind:'ok'};}}});
  await poll.tick();assert.equal(sent[0].event,'end');assert.ok(sent[0].state);assert.equal(calls,0);assert.equal(store.read().activities.a.status,'ended');store.close();
});
test('missing upstream scores retain last known state without refreshing its timestamp',async()=>{
  const store=openStore(':memory:');store.change(s=>s.activities.a=activity({id:'a'}));let sent=0;
  const poll=createPoller({store,sleeper:{...sleeper,matchups:async()=>({rows:[{...rows[0],points:null},rows[1]],updatedAt:T+100})},now:()=>T*1000,log:()=>{},transport:{send:async()=>{sent++;}}});
  await poll.tick();assert.equal(sent,0);assert.equal(store.read().activities.a.state.updatedAt,T);store.close();
});
test('Sleeper concurrent fetches are deduplicated and cached',async()=>{
  let calls=0;const api=createSleeper(async()=>{calls++;await new Promise(r=>setTimeout(r,5));return rows;});
  await Promise.all([api.matchups('123456789',6),api.matchups('123456789',6)]);assert.equal(calls,1);
});
test('time estimate falls with no scoring and rises with new points',()=>{
  const game={status:{type:{name:'STATUS_IN_PROGRESS'},period:3,clock:900}};
  const p=new Map([['1',{team:'KC',player:{position:'WR'},stats:{gp:1,rec:5,rec_yd:100}}]]), games=new Map([['KC',game]]);
  const row={points:4,starters:['1']};const rules={rec:1,rec_yd:0.1};
  assert.equal(estimateTeam(row,rules,p,games).points,11.5);
  game.status.clock=0;assert.equal(estimateTeam(row,rules,p,games).points,7.75);
  row.points=10;assert.equal(estimateTeam(row,rules,p,games).points,13.75);
  game.status.type.completed=true;assert.deepEqual(estimateTeam(row,rules,p,games),{points:10,kind:'final'});
});
test('unsupported scoring, missing game, overtime and delay make estimate unavailable',()=>{
  assert.equal(projectedPoints({gp:1,pass_yd:310},{bonus_pass_yd_300:3}),null);
  assert.equal(estimateTeam({points:0,starters:['missing']},{},new Map(),new Map()),null);
  assert.equal(gameProgress({status:{type:{name:'STATUS_IN_PROGRESS'},period:5,clock:400}}),null);
  assert.equal(gameProgress({status:{type:{name:'STATUS_DELAYED'},period:2,clock:100}}),null);
});
test('defense estimate does not double-count initial points-allowed credit',()=>{
  const p=new Map([['KC',{team:'KC',player:{position:'DEF'},stats:{gp:1,pts_allow_14_20:1,sack:2}}]]);
  const games=new Map([['KC',{status:{type:{name:'STATUS_SCHEDULED'}}}]]);
  assert.equal(estimateTeam({points:10,starters:['KC'],players_points:{KC:10}},{pts_allow_0:10,pts_allow_14_20:1,sack:1},p,games).points,3);
});
test('invalid timing configuration rejected',()=>{
  assert.throws(()=>config({INVITE_CODE:cfg.invite,POLL_SECONDS:'0'}));
  assert.throws(()=>config({INVITE_CODE:cfg.invite,APNS_MODE:'live'}));
});

test('transient push failure retries after backoff and preserves data',async()=>{
  let time=T,attempts=0;const store=openStore(':memory:');store.change(s=>s.activities.a=activity({id:'a'}));
  const poll=createPoller({store,sleeper,now:()=>time*1000,log:()=>{},transport:{send:async()=>({kind:++attempts===1?'retry':'ok'})}});
  await poll.tick();assert.equal(store.read().activities.a.state.yourScore,0);
  time+=10;await poll.tick();assert.equal(attempts,1);
  time+=75;await poll.tick();assert.equal(attempts,2);assert.equal(store.read().activities.a.state.yourScore,10);store.close();
});
test('poller single flight and end during projection fetch prevents a late update',async()=>{
  const store=openStore(':memory:');store.change(s=>s.activities.a=activity({id:'a'}));let sent=0;
  let release;const gate=new Promise(r=>release=r);
  const poll=createPoller({store,sleeper,now:()=>T*1000,estimator:async()=>{await gate;return [null,null];},transport:{send:async()=>{sent++;return {kind:'ok'};}}});
  const one=poll.tick();assert.equal(poll.tick(),one);
  await new Promise(r=>setImmediate(r));store.change(s=>{s.activities.a.status='ended';s.activities.a.version++;});release();await one;
  assert.equal(sent,0);store.close();
});
test('explicit bye and finished player require no projection; missing scheduled stats remain unavailable',()=>{
  const p=new Map([['1',{team:'KC',player:{position:'WR'}}]]);
  const games=new Map([['KC',{status:{type:{completed:true}},bye:true}]]);
  assert.deepEqual(estimateTeam({points:0,starters:['1']},{rec:1},p,games),{points:0,kind:'final'});
  games.set('KC',{status:{type:{name:'STATUS_SCHEDULED'}}});
  assert.equal(estimateTeam({points:0,starters:['1']},{rec:1},p,games),null);
});
test('SIGKILL leaves committed SQLite registration recoverable',async()=>{
  const {spawn}=await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'sleeper-kill-')),file=join(dir,'data.db');
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {openStore} from ${JSON.stringify(new URL('../registrations.js',import.meta.url).href)};
    const s=openStore(${JSON.stringify(file)});s.change(d=>d.activities.a=${JSON.stringify(activity())});
    console.log('ready');setInterval(()=>{},1000);
  `],{stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(Error('Early exit '+code)));});
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
    const s=openStore(file);assert.equal(s.read().activities.a.id,'activity-1');s.close();
  }finally{child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
});


test('score changes are urgent; initial unchanged snapshot, projections, and heartbeats are not',async()=>{
  let time=T, yours=10, opponent=20, projection=100;
  const store=openStore(':memory:');
  const initial={yourScore:10,opponentScore:20,yourProjected:100,opponentProjected:110,
    yourProjectionKind:'estimate',opponentProjectionKind:'estimate',updatedAt:T};
  store.change(s=>s.activities.a=activity({id:'a',state:initial}));
  const sent=[];
  const poll=createPoller({store,now:()=>time*1000,
    sleeper:{...sleeper,matchups:async()=>({rows:[{...rows[0],points:yours},{...rows[1],points:opponent}],updatedAt:time})},
    estimator:async()=>[{points:projection,kind:'estimate'},{points:110,kind:'estimate'}],
    transport:{send:async m=>{sent.push(m);return {kind:'ok'};}}});
  try {
    await poll.tick();assert.equal(pushPriority(sent.at(-1)),'5');
    time+=75;await poll.tick();assert.equal(sent.length,1);
    time+=75;yours=10.1;await poll.tick();assert.equal(pushPriority(sent.at(-1)),'10');
    time+=75;opponent=20.1;await poll.tick();assert.equal(pushPriority(sent.at(-1)),'10');
    time+=75;yours=9.9;await poll.tick();assert.equal(pushPriority(sent.at(-1)),'10');
    time+=75;projection=95;await poll.tick();assert.equal(pushPriority(sent.at(-1)),'5');
    time+=225;await poll.tick();assert.equal(pushPriority(sent.at(-1)),'5');
    time+=75;store.change(s=>s.activities.a.status='ending');await poll.tick();
    assert.equal(sent.at(-1).event,'end');assert.equal(pushPriority(sent.at(-1)),'10');
  } finally {store.close();}
});

test('failed urgent push retries the latest score urgently without advancing accepted state',async()=>{
  let time=T,points=1;const store=openStore(':memory:');const sent=[];
  store.change(s=>s.activities.a=activity({id:'a'}));
  const poll=createPoller({store,now:()=>time*1000,log:()=>{},
    sleeper:{...sleeper,matchups:async()=>({rows:[{...rows[0],points},{...rows[1],points:0}],updatedAt:time})},
    transport:{send:async m=>{sent.push(m);return {kind:sent.length===1?'retry':'ok'};}}});
  try {
    await poll.tick();assert.equal(store.read().activities.a.state.yourScore,0);
    time+=75;points=2;await poll.tick();
    assert.deepEqual(sent.map(pushPriority),['10','10']);
    assert.equal(sent.at(-1).state.yourScore,2);assert.equal(store.read().activities.a.sentState.yourScore,2);
    time+=225;await poll.tick();assert.equal(pushPriority(sent.at(-1)),'5');
  } finally {store.close();}
});

test('device recovery requires valid credentials and does not expose secrets',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/v1/devices/me')).status,401);
  const response=await f.call('/v1/devices/me','GET',undefined,f.token);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{deviceId:f.token.split('.')[0]});
});


test('compressed JSON and trailing bytes are rejected before enrollment or activity writes',async t=>{
  const f=await fixture(t,{cfg:{attestEnabled:true}});
  const before=f.store.read();
  for(const [encoding,compress] of [['gzip',gzipSync],['deflate',deflateSync],['br',brotliCompressSync]]){
    for(const trailing of [false,true]){
      for(const [path,method,body,token] of [
        ['/v1/devices','POST',{inviteCode:cfg.invite},null],
        ['/v1/enrollment/challenge','POST',{keyId:Buffer.alloc(32).toString('base64'),credentialHash:'a'.repeat(64)},null],
        ['/v1/activities/compression-test','PUT',registration,f.token],
      ]){
        const frame=compress(Buffer.from(JSON.stringify(body)));
        const res=await fetch(f.root+path,{method,headers:{'content-type':'application/json','content-encoding':encoding,...(token?{authorization:`Bearer ${token}`}:{})},body:trailing?Buffer.concat([frame,Buffer.from('invalid-trailing-bytes')]):frame});
        assert.equal(res.status,415,`${encoding} trailing=${trailing} ${path}`);
        assert.equal((await res.json()).error,'encoding.unsupported');
      }
    }
  }
  assert.deepEqual(f.store.read(),before,'rejected requests must not change registrations');
  assert.equal((await f.call('/health')).status,200,'server remains responsive');
  assert.equal((await f.call('/v1/activities/plain-json-test','PUT',registration,f.token)).status,201,'plain JSON still registers an activity');
});


test('ingress limits rotating invalid tokens before database reads and resets at expiry',async t=>{
  let time=T*1000;
  const f=await fixture(t,{now:()=>time});
  let reads=0;
  const read=f.store.read;
  f.store.read=()=>{reads++;return read();};
  // The fixture's enrollment used one of this IP's 400 admissions.
  for(let i=0;i<399;i++){
    const token=i.toString(16).padStart(32,'0')+'.'+'a'.repeat(64);
    assert.equal((await f.call('/v1/devices/me','GET',undefined,token)).status,401);
  }
  assert.equal(reads,0);
  const blocked=await f.call('/v1/devices/me');
  assert.equal(blocked.status,429);
  assert.equal(blocked.headers.get('retry-after'),'60');
  assert.equal(blocked.headers.get('cache-control'),'no-store');
  assert.deepEqual(await blocked.json(),{error:'rate_limited'});
  assert.equal(reads,0,'invalid credentials must not read SQLite');
  assert.equal((await f.call('/v1/devices/me','GET',undefined,f.token)).status,200,'valid device retains a separate allowance');
  // Even malformed JSON is rejected by ingress before the parser or enrollment.
  for(const path of ['/v1/devices','/v1/enrollment/challenge']){
    const response=await fetch(f.root+path,{method:'POST',headers:{'content-type':'application/json'},body:'{'});
    assert.equal(response.status,429);
  }
  assert.equal((await f.call('/health')).status,200);
  assert.equal(reads,0);
  time+=59000;
  assert.equal((await f.call('/v1/devices/me')).headers.get('retry-after'),'1');
  time+=1000;
  assert.equal((await f.call('/v1/devices/me','GET',undefined,f.token)).status,200);
  assert.equal(reads,0);
});

test('global ingress budget bounds rotating IPs and recovers without database work',async t=>{
  let time=T*1000;
  const f=await fixture(t,{now:()=>time,cfg:{clientIPMode:'railway-public'}});
  let reads=0;
  const read=f.store.read;
  f.store.read=()=>{reads++;return read();};
  // Simulate edge-provided headers; this is not a live Railway proxy audit.
  for(let i=0;i<1199;i++){
    const res=await fetch(f.root+'/v1/devices/me',{headers:{'x-real-ip':`2001:db8::${(i+1).toString(16)}`}});
    assert.equal(res.status,401);
  }
  const res=await fetch(f.root+'/v1/devices/me',{headers:{'x-real-ip':'192.0.2.1'}});
  assert.equal(res.status,429);
  assert.equal(reads,0,'missing credentials and globally blocked requests do not read SQLite');
  time+=60000;
  assert.equal((await f.call('/v1/devices/me','GET',undefined,f.token)).status,200);
});

test('twelve devices sharing an IP retain their individual authenticated budgets',async t=>{
  let time=T*1000;
  const f=await fixture(t,{now:()=>time});
  const tokens=[f.token];
  // Respect the existing invitation limit while creating the test devices.
  for(let i=1;i<12;i++){
    if(i===10)time+=60001;
    const res=await f.call('/v1/devices','POST',{inviteCode:cfg.invite});
    assert.equal(res.status,201);
    tokens.push((await res.json()).deviceToken);
  }
  time+=60001;
  for(const token of tokens){
    for(let i=0;i<30;i++)assert.equal((await f.call('/v1/devices/me','GET',undefined,token)).status,200);
    assert.equal((await f.call('/v1/devices/me','GET',undefined,token)).status,429);
  }
});


test('invite enrollment policy defaults closed with App Attest and validates explicit overrides',()=>{
  const attested={APP_ATTEST_ENABLED:'true',APP_ATTEST_APP_ID_PREFIX:'ABCDEFGHIJ',APNS_BUNDLE_ID:'com.example.test'};
  assert.equal(config(attested).inviteEnabled,false,'attested enrollment needs no invite secret');
  assert.equal(config({...attested,INVITE_CODE:cfg.invite}).inviteEnabled,false,'a leftover secret cannot enable the route');
  assert.equal(config({INVITE_CODE:cfg.invite}).inviteEnabled,true,'private local mode remains compatible');
  assert.equal(config({INVITE_ENROLLMENT_ENABLED:'false'}).inviteEnabled,false);
  assert.throws(()=>config({INVITE_CODE:cfg.invite,INVITE_ENROLLMENT_ENABLED:'yes'}));
  assert.throws(()=>config({...attested,INVITE_ENROLLMENT_ENABLED:'true'}));
  assert.equal(config({...attested,INVITE_ENROLLMENT_ENABLED:'true',INVITE_CODE:cfg.invite}).inviteEnabled,true);
});

test('disabled invite enrollment does not access storage or invalidate existing credentials',async t=>{
  const store=openStore(':memory:');
  const id='b'.repeat(32),secret='c'.repeat(64);
  store.change(s=>s.devices[id]={hash:createHash('sha256').update(secret).digest('hex'),createdAt:T});
  let reads=0,writes=0;
  const observed={credentialHash:store.credentialHash,read:()=>{reads++;return store.read();},change:fn=>{writes++;return store.change(fn);}};
  const app=createApp({cfg:{...cfg,inviteEnabled:false,attestEnabled:true},store:observed,sleeper,now:()=>T*1000});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.on('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  const root=`http://127.0.0.1:${server.address().port}`;
  for(const inviteCode of [cfg.invite,'wrong']){
    const res=await fetch(root+'/v1/devices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({inviteCode})});
    assert.equal(res.status,404);
    assert.equal(res.headers.get('cache-control'),'no-store');
    assert.deepEqual(await res.json(),{error:'not_found'});
  }
  assert.equal(reads,0);assert.equal(writes,0);
  const auth={authorization:`Bearer ${id}.${secret}`};
  assert.equal((await fetch(root+'/v1/devices/me',{headers:auth})).status,200);
  assert.equal((await fetch(root+'/v1/activities/existing-device-test',{method:'PUT',headers:{...auth,'content-type':'application/json'},body:JSON.stringify(registration)})).status,201);
  assert.equal((await fetch(root+'/v1/devices/me',{method:'DELETE',headers:auth})).status,204);
  assert.equal((await fetch(root+'/v1/devices/me',{headers:auth})).status,401);
});

test('explicit private invite enrollment works alongside App Attest and never caches credentials',async t=>{
  const f=await fixture(t,{cfg:{attestEnabled:true,inviteEnabled:true}});
  const res=await f.call('/v1/devices','POST',{inviteCode:cfg.invite});
  assert.equal(res.status,201);
  assert.equal(res.headers.get('cache-control'),'no-store');
  const credentials=await res.json();
  assert.equal((await f.call('/v1/devices/me','GET',undefined,credentials.deviceToken)).status,200);
});


test('public health preserves the iOS contract without exposing or consulting internal status',async t=>{
  for(const mode of ['live','dry-run']){
    const f=await fixture(t,{cfg:{mode},poller:{status:()=>{throw Error('private database path and credentials');}}});
    let reads=0;
    const read=f.store.read;
    f.store.read=()=>{reads++;return read();};
    const response=await f.call('/health');
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{ok:true,mode});
    assert.equal(reads,0,'public liveness must not read private registrations');
  }
});


test('ingress configuration keeps safe defaults and rejects invalid limits',()=>{
  const base={INVITE_ENROLLMENT_ENABLED:'false'};
  const defaults=config(base);
  assert.equal(defaults.ingressPerIP,400);
  assert.equal(defaults.ingressGlobal,1200);
  const custom=config({...base,API_REQUESTS_PER_IP_PER_MINUTE:'800',API_REQUESTS_PER_MINUTE:'2400'});
  assert.equal(custom.ingressPerIP,800);assert.equal(custom.ingressGlobal,2400);
  for(const name of ['API_REQUESTS_PER_IP_PER_MINUTE','API_REQUESTS_PER_MINUTE']){
    for(const value of ['','0','-1','1.5','NaN','Infinity','10001']){
      assert.throws(()=>config({...base,[name]:value}),undefined,`${name}=${value}`);
    }
  }
  assert.throws(()=>config({...base,API_REQUESTS_PER_IP_PER_MINUTE:'500',API_REQUESTS_PER_MINUTE:'400'}));
});

test('configured ingress budgets enforce separate IP and total limits before reads',async t=>{
  let time=T*1000;
  const f=await fixture(t,{cfg:{ingressPerIP:2,ingressGlobal:4,clientIPMode:'railway-public'},now:()=>time});
  let reads=0;
  const read=f.store.read;
  f.store.read=()=>{reads++;return read();};
  const request=ip=>fetch(f.root+'/v1/devices/me',{headers:{'x-real-ip':ip}});
  // Fixture enrollment consumed one global admission on the loopback address.
  assert.equal((await request('192.0.2.1')).status,401);
  assert.equal((await request('192.0.2.1')).status,401);
  assert.equal((await request('192.0.2.1')).status,429);
  assert.equal((await request('192.0.2.2')).status,401);
  assert.equal((await request('192.0.2.3')).status,429);
  assert.equal(reads,0);
  time+=60000;
  assert.equal((await f.call('/v1/devices/me','GET',undefined,f.token)).status,200);
});

test('bounded push workers let other users progress while one send stalls; shutdown waits',async()=>{
  const store=openStore(':memory:');
  store.change(s=>{for(let i=0;i<6;i++)s.activities[`a${i}`]=activity({id:`a${i}`,token:`token${i}`});});
  let release,active=0,peak=0,fetches=0;
  const gate=new Promise(resolve=>release=resolve),sent=[];
  const poll=createPoller({store,pushConcurrency:2,now:()=>T*1000,
    sleeper:{...sleeper,matchups:async()=>{fetches++;return {rows,updatedAt:T};}},
    transport:{send:async message=>{
      active++;peak=Math.max(peak,active);sent.push(message.token);
      try{if(message.token==='token0')await gate;return {kind:'ok'};}finally{active--;}
    }}});
  const tick=poll.tick();
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(poll.tick(),tick,'another tick cannot overlap active workers');
    assert.equal(sent.length,6,'other activities finish before the stalled send');
    assert.equal(peak,2);assert.equal(fetches,1);
    assert.equal(store.read().activities.a5.sentAt,T);
    let stopped=false;
    const stop=poll.stop().then(()=>{stopped=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(stopped,false);
    release();await tick;await stop;
    assert.equal(active,0);assert.equal(stopped,true);
  }finally{release();await tick;store.close();}
});

test('concurrent push failures respect token rotation, queued ending, and retry isolation',async()=>{
  const store=openStore(':memory:');
  store.change(s=>{for(let i=0;i<4;i++)s.activities[`a${i}`]=activity({id:`a${i}`,token:`token${i}`});});
  let release;
  const gate=new Promise(resolve=>release=resolve),sent=[];
  const poll=createPoller({store,sleeper,pushConcurrency:2,now:()=>T*1000,log:()=>{},transport:{send:async message=>{
    sent.push(message.token);
    if(message.token==='token0'){await gate;return {kind:'dead'};}
    if(message.token==='token1'){await gate;throw Error('test transport failure');}
    return {kind:'ok'};
  }}});
  const tick=poll.tick();
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(sent,['token0','token1']);
    store.change(s=>{
      s.activities.a0.token='replacement';s.activities.a0.version++;
      s.activities.a2.status='ended';s.activities.a2.token=null;s.activities.a2.version++;
    });
    release();await tick;
    const state=store.read();
    assert.equal(state.activities.a0.status,'active');assert.equal(state.activities.a0.token,'replacement');
    assert.equal(state.activities.a1.failures,1);assert.ok(state.activities.a1.nextAttempt>T);
    assert.equal(sent.includes('token2'),false,'queued local end is rechecked before sending');
    assert.equal(state.activities.a3.sentAt,T);
  }finally{release();await tick;store.close();}
});

test('push concurrency configuration has bounded positive integer limits',()=>{
  const base={INVITE_ENROLLMENT_ENABLED:'false'};
  assert.equal(config(base).pushConcurrency,4);
  assert.equal(config({...base,APNS_MAX_CONCURRENT_SENDS:'8'}).pushConcurrency,8);
  for(const value of ['0','-1','1.5','17','NaN',''])assert.throws(()=>config({...base,APNS_MAX_CONCURRENT_SENDS:value}));
});

test('forged forwarded headers cannot rotate direct or Railway-public rate identities',async t=>{
  for(const clientIPMode of ['direct','railway-public']){
    const f=await fixture(t,{cfg:{clientIPMode,ingressPerIP:2,ingressGlobal:20}});
    const headers={'x-real-ip':clientIPMode==='direct'?'192.0.2.1':'127.0.0.1','x-forwarded-for':'192.0.2.1',forwarded:'for=192.0.2.1'};
    assert.equal((await fetch(f.root+'/v1/devices/me',{headers})).status,401);
    headers['x-forwarded-for']='192.0.2.2';headers.forwarded='for=192.0.2.2';
    if(clientIPMode==='direct')headers['x-real-ip']='192.0.2.2';
    assert.equal((await fetch(f.root+'/v1/devices/me',{headers})).status,429);
  }
});

test('anonymous floods cannot consume authenticated matchup or activity budgets',async t=>{
  const f=await fixture(t,{cfg:{ingressPerIP:5,ingressGlobal:5,attestEnabled:true}});
  const id=f.token.split('.')[0];
  let reads=0;
  const read=f.store.read;
  f.store.read=()=>{reads++;return read();};
  // Enrollment already consumed one anonymous admission. Guessing a known ID
  // with the wrong secret must remain anonymous and never read SQLite.
  for(let i=0;i<4;i++){
    const response=await f.call('/v1/devices/me','GET',undefined,`${id}.${i.toString(16).padStart(64,'0')}`);
    assert.equal(response.status,401);
  }
  for(let i=0;i<20;i++)assert.equal((await f.call('/v1/devices/me')).status,429);
  // Even attaching a valid credential to enrollment cannot spend the auth budget.
  assert.equal((await f.call('/v1/enrollment/challenge','POST',{},f.token)).status,429);
  assert.equal((await f.call('/v1/devices','POST',{inviteCode:cfg.invite},f.token)).status,429);
  assert.equal(reads,0);
  assert.equal((await f.call('/v1/matchup?leagueId=123456789&week=6&rosterId=1','GET',undefined,f.token)).status,200);
  assert.equal((await f.call('/v1/activities/flood-test','PUT',registration,f.token)).status,201);
  for(let i=0;i<3;i++)assert.equal((await f.call('/v1/devices/me','GET',undefined,f.token)).status,200);
  assert.equal((await f.call('/v1/devices/me','GET',undefined,f.token)).status,429,'authenticated processing remains bounded too');
});

test('credential index reflects only committed state and rebuilds after restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'credential-index-')),file=join(dir,'state.db');
  let store=openStore(file);
  try{
    store.change(s=>s.devices.example={hash:'original'});
    assert.equal(store.credentialHash('example'),'original');
    assert.throws(()=>store.change(s=>{s.devices.example.hash='uncommitted';throw Error('abort');}));
    assert.equal(store.credentialHash('example'),'original');
    store.close();store=openStore(file);
    assert.equal(store.credentialHash('example'),'original');
    store.change(s=>s.devices.example.revoked=true);
    assert.equal(store.credentialHash('example'),undefined);
    store.close();store=openStore(file);
    assert.equal(store.credentialHash('example'),undefined);
    assert.equal(store.credentialHash('unknown'),undefined);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
