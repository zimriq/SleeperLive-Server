// Isolated benchmark: never loads .env, real Apple keys, live SQLite, or upstream APIs.
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { openStore } from '../registrations.js';
import { createApp } from '../app.js';
import { createSleeper } from '../sleeper.js';
import { createPoller } from '../poller.js';
import { payload } from '../apns.js';

const scenarios=['idle','shared-league','12-leagues','12-leagues-outages'];
const quantile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))]??0;
if (!process.argv.includes('--worker')) {
  const results=[];
  for(const scenario of scenarios) {
    const result=await new Promise((resolve,reject)=>{
      const child=fork(new URL(import.meta.url),['--worker',scenario],{stdio:['ignore','ignore','inherit','ipc'],env:{PATH:process.env.PATH}});
      let result; child.on('message',v=>result=v);child.on('error',reject);child.on('exit',code=>code===0&&result?resolve(result):reject(Error(`${scenario}: exit ${code}`)));
    });
    results.push(result);console.log(JSON.stringify(result));
  }
  writeFileSync(new URL('../load-test-results.json',import.meta.url),JSON.stringify({recordedAt:new Date().toISOString(),platform:platform(),arch:arch(),cpu:cpus()[0].model,node:process.version,simulatedSecondsPerCycle:75,cycles:360,users:12,projections:false,results},null,2)+'\n');
} else {
  const name=process.argv.at(-1), idle=name==='idle', faults=name.endsWith('outages'), shared=name==='shared-league';
  const dir=mkdtempSync(join(tmpdir(),'sleeper-load-'));const store=openStore(join(dir,'benchmark.sqlite'));
  let time=1800000000, cycle=-1, upstreamCalls=0, upstreamBytes=0, outboundBytes=0, pushAttempts=0,pushFailures=0,apiRequests=0,apiFailures=0,upstreamFailures=0;
  const now=()=>time*1000;
  const sleeper=createSleeper(async url=>{
    upstreamCalls++;outboundBytes+=Buffer.byteLength(url)+350;
    if(faults&&cycle>=60&&cycle<65) {upstreamFailures++;throw Error('Simulated upstream outage');}
    const ids=Array.from({length:12},(_,i)=>i+1);
    let result;
    if(url.includes('/matchups/')) result=ids.map(i=>({roster_id:i,matchup_id:Math.ceil(i/2),points:Math.max(0,cycle)*0.1+i,starters:Array.from({length:9},(_,j)=>String(i*100+j)),players:Array.from({length:20},(_,j)=>String(i*100+j))}));
    else if(url.endsWith('/rosters')) result=ids.map(i=>({roster_id:i,owner_id:'user-'+i,players:Array.from({length:20},(_,j)=>String(i*100+j))}));
    else if(url.endsWith('/users')) result=ids.map(i=>({user_id:'user-'+i,display_name:'Benchmark Team '+i,metadata:{team_name:'Benchmark Team '+i}}));
    else result={name:'Benchmark league',season:'2026',scoring_settings:{rec:1,rec_yd:0.1}};
    const json=JSON.stringify(result);upstreamBytes+=Buffer.byteLength(json);
    // Exercise JSON parsing and the actual caching layer, without external traffic.
    return JSON.parse(json);
  },now);
  const transport={send:async message=>{
    pushAttempts++;outboundBytes+=Buffer.byteLength(JSON.stringify(payload(message)))+800;
    if(faults&&pushAttempts%10===0){pushFailures++;return {kind:'retry',reason:'SimulatedTimeout'};}
    return {kind:'ok'};
  }};
  const poller=createPoller({store,sleeper,transport,now,log:()=>{}});
  const app=createApp({cfg:{invite:'benchmark-only-not-a-real-secret',maxDevices:50,maxActivities:100,perDevice:3,mode:'dry-run'},store,sleeper,poller,now});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;const latencies=[];
  async function call(path,method='GET',body,token) {
    const begin=performance.now();const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
    const text=await r.text();latencies.push(performance.now()-begin);apiRequests++;outboundBytes+=Buffer.byteLength(text)+250;if(!r.ok)apiFailures++;
    return {status:r.status,data:text?JSON.parse(text):null};
  }
  try {
    const users=[];
    if(!idle)for(let i=0;i<12;i++){
      if(i===10)time+=61; // Respect the real 10 enrollments/IP/minute guard.
      const auth=await call('/v1/devices','POST',{inviteCode:'benchmark-only-not-a-real-secret'});assert.equal(auth.status,201);
      const selection={leagueId:shared?'123456789':String(123456789+i),week:7,rosterId:shared?i+1:1};
      const r=await call('/v1/activities/benchmark-'+i,'PUT',{...selection,pushToken:'aa'.repeat(32),apnsEnvironment:'development',startedAt:time},auth.data.deviceToken);assert.equal(r.status,201);
      users.push({selection,token:auth.data.deviceToken});
    }
    time+=75;
    const cpuStart=process.cpuUsage(),wallStart=performance.now(),samples=[],ticks=[];const delay=monitorEventLoopDelay({resolution:10});delay.enable();
    const sampler=setInterval(()=>samples.push(process.memoryUsage().rss),20);
    samples.push(process.memoryUsage().rss);
    const baseRequests=apiRequests,baseFailures=apiFailures;
    if(idle) { await poller.tick();await new Promise(r=>setTimeout(r,10000)); }
    else for(cycle=0;cycle<360;cycle++){
      time+=75;
      const start=performance.now();
      // Worst foreground case: every one of the 12 apps refreshes every cycle.
      await Promise.all(users.map(({selection:s,token})=>call(`/v1/matchup?leagueId=${s.leagueId}&week=7&rosterId=${s.rosterId}`,'GET',null,token)));
      await poller.tick();ticks.push(performance.now()-start);samples.push(process.memoryUsage().rss);
      await new Promise(r=>setImmediate(r));
    }
    clearInterval(sampler);delay.disable();
    const cpu=process.cpuUsage(cpuStart),wallSeconds=(performance.now()-wallStart)/1000;
    const cpuSeconds=(cpu.user+cpu.system)/1e6;
    const diskBytes=readdirSync(dir).reduce((sum,f)=>sum+statSync(join(dir,f)).size,0);
    const active=Object.values(store.read().activities).filter(a=>a.status==='active').length;
    assert.equal(active,idle?0:12);assert.equal(apiFailures-baseFailures,faults?60:0);
    if(!idle)assert.equal(Object.values(store.read().activities).every(a=>a.sentAt>1800000000),true);
    process.send({name,wallSeconds,cpuSeconds,simulatedHours:idle?null:7.5,meanRssMiB:samples.reduce((a,b)=>a+b,0)/samples.length/1048576,peakRssMiB:Math.max(...samples)/1048576,processMaxRssMiB:process.resourceUsage().maxRSS/1024,cycleP95Ms:quantile(ticks,.95),httpP95Ms:quantile(latencies,.95),eventLoopP99Ms:delay.percentile(99)/1e6,diskMiB:diskBytes/1048576,apiRequests,expectedApiFailures:apiFailures,upstreamCalls,simulatedUpstreamResponseBytes:upstreamBytes,modeledOutboundBytes:outboundBytes,pushAttempts,pushFailures,upstreamFailures,activeAtEnd:active});
  } finally {await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});}
}
