import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openStore } from '../registrations.js';
import { createPoller } from '../poller.js';

const time = 1800000000;
const rows = [{roster_id:1,matchup_id:1,points:10},{roster_id:2,matchup_id:1,points:20}];
const state = {yourScore:0,opponentScore:0,updatedAt:time};
const sleeper = {
  matchups:async()=>({rows,updatedAt:time}),
  meta:async()=>({info:{name:'Benchmark',season:'2026'},rosters:[],users:[]}),
};

for (const activities of [100,300,1000]) {
  const samples=[];
  for (let run=0;run<5;run++) {
    const dir=mkdtempSync(join(tmpdir(),'sleeper-store-benchmark-'));
    const store=openStore(join(dir,'state.sqlite'));
    try {
      store.change(s=>{
        for(let i=0;i<activities;i++){
          const id=String(i);
          s.devices[id]={hash:'a'.repeat(64),createdAt:time,lastSeenAt:time};
          s.activities[id]={id,deviceId:id,leagueId:'123456789',week:6,rosterId:1,token:'a'.repeat(64),
            env:'development',status:'active',version:1,expiresAt:time+28800,startedAt:time,
            nextAttempt:0,failures:0,force:true,pushTimestamp:0,state};
        }
      });
      let transactions=0,sends=0;
      const measured={...store,change(fn){transactions++;return store.change(fn);}};
      const poller=createPoller({store:measured,sleeper,now:()=>time*1000,log:()=>{},
        transport:{send:async()=>{sends++;return {kind:'ok'};}}});
      const start=performance.now();
      await poller.tick();
      samples.push({tickMs:performance.now()-start,transactions});
      assert.equal(sends,activities);
      assert.ok(Object.values(store.read().activities).every(a=>a.sentAt===time));
    } finally {
      store.close();
      rmSync(dir,{recursive:true,force:true});
    }
  }
  const times=samples.map(s=>s.tickMs).sort((a,b)=>a-b);
  const round=value=>Math.round(value*10)/10;
  console.log(JSON.stringify({activities,medianTickMs:round(times[2]),minTickMs:round(times[0]),
    maxTickMs:round(times.at(-1)),transactions:samples.map(s=>s.transactions)}));
}
