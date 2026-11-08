import test from 'node:test';
import assert from 'node:assert/strict';
import { createEstimator } from '../projections.js';
import { snapshot } from '../sleeper.js';

const league={season:'2026',name:'Test',scoring_settings:{rec:1}};
const rows=[{roster_id:1,matchup_id:1,points:10,starters:['p']},{roster_id:2,matchup_id:1,points:20,starters:['p']}];
function validFeed(url){
  if(url.includes('/players/'))return {p:{team:'KC',position:'WR'}};
  if(url.includes('/projections/')){
    const week=Number(url.match(/2026\/(\d+)/)[1]);
    return [{player_id:'p',team:'KC',player:{position:'WR'},season:'2026',week,season_type:'regular',stats:{gp:1,rec:5}}];
  }
  const week=Number(new URL(url).searchParams.get('week'));
  return {season:{year:2026},week:{number:week},events:[{season:{year:2026},week:{number:week},status:{type:{name:'STATUS_SCHEDULED'}},competitions:[{competitors:[{team:{abbreviation:'KC'}}]}]}]};
}

test('projection outage has one shared cooldown, preserves actual scores and recovers',async()=>{
  let time=100000,failed=true,calls=0;
  const estimator=createEstimator(async url=>{calls++;if(failed)throw Error('offline');return validFeed(url);},()=>time);
  const meta={info:league,rosters:[],users:[]};
  const snap=await snapshot({rows,updatedAt:100},meta,1,6,estimator);
  assert.equal(snap.state.yourScore,10);
  assert.equal(snap.state.opponentScore,20);
  assert.equal(snap.state.yourProjected,null);
  assert.equal(calls,3);
  for(let i=0;i<12;i++)assert.deepEqual(await estimator(league,i%2?7:6,rows),[null,null]);
  assert.equal(calls,3,'different weeks cannot bypass the outage cooldown');
  failed=false;time+=59999;
  assert.deepEqual(await estimator(league,6,rows),[null,null]);
  assert.equal(calls,3);
  time++;
  const recovered=await Promise.all(Array.from({length:12},()=>estimator(league,6,rows)));
  assert.equal(calls,6,'recovery shares a single batch');
  for(const result of recovered)assert.deepEqual(result,[{points:15,kind:'estimate'},{points:25,kind:'estimate'}]);
});

test('malformed projection feeds cool down and expired estimates are not reused',async()=>{
  let time=100000,calls=0,malformed=false;
  const estimator=createEstimator(async url=>{calls++;return malformed&&url.includes('scoreboard')?{events:[]}:validFeed(url);},()=>time);
  assert.equal((await estimator(league,6,rows))[0].points,15);
  assert.equal(calls,3);
  time+=60001;malformed=true;
  assert.deepEqual(await estimator(league,6,rows),[null,null]);
  assert.equal(calls,5,'daily player data is still cached');
  time+=59000;
  assert.deepEqual(await estimator(league,6,rows),[null,null]);
  assert.equal(calls,5);
  time+=1000;malformed=false;
  assert.equal((await estimator(league,6,rows))[0].points,15);
  assert.equal(calls,7);
});

test('failed batch waits for outstanding requests and does not overlap retries',async()=>{
  let calls=0,time=100000,release;
  const gate=new Promise(resolve=>release=resolve);
  const estimator=createEstimator(async url=>{
    calls++;
    if(url.includes('/projections/'))throw Error('offline');
    await gate;return validFeed(url);
  },()=>time);
  const first=estimator(league,6,rows);
  const otherWeek=estimator(league,7,rows);
  time+=120000;
  const duplicate=estimator(league,6,rows);
  assert.equal(calls,3,'one batch remains in flight even beyond the cooldown duration');
  release();
  assert.deepEqual(await Promise.all([first,otherWeek,duplicate]),[[null,null],[null,null],[null,null]]);
  time+=59999;
  await estimator(league,7,rows);
  assert.equal(calls,3,'cooldown starts when the failed batch settles');
});

test('concurrent successful weeks use their own feed results',async()=>{
  let calls=0;
  const estimator=createEstimator(async url=>{calls++;return validFeed(url);},()=>100000);
  const result=await Promise.all([estimator(league,6,rows),estimator(league,7,rows)]);
  for(const estimates of result)assert.equal(estimates[0].points,15);
  assert.equal(calls,5,'second week reuses the daily player cache');
});

test('alternating weeks retain independent estimates until their own freshness expires',async()=>{
  let calls=0,time=100000;
  const estimator=createEstimator(async url=>{calls++;return validFeed(url);},()=>time);
  await estimator(league,6,rows);time+=10000;await estimator(league,7,rows);
  for(let i=0;i<10;i++)assert.equal((await estimator(league,i%2?6:7,rows))[0].points,15);
  assert.equal(calls,5);
  time=160001;await estimator(league,6,rows);assert.equal(calls,7);
  await estimator(league,7,rows);assert.equal(calls,7,'week 7 has its own freshness deadline');
});

test('estimate cache stays bounded and evicts the least recently used season/week',async()=>{
  let calls=0;
  const estimator=createEstimator(async url=>{calls++;return validFeed(url);},()=>100000);
  for(let week=1;week<=4;week++)await estimator(league,week,rows);
  assert.equal(calls,9);
  await estimator(league,1,rows);await estimator(league,5,rows);assert.equal(calls,11);
  await estimator(league,1,rows);assert.equal(calls,11);
  await estimator(league,2,rows);assert.equal(calls,13);
});

test('invalid season and week values never reach upstream feeds',async()=>{
  let calls=0;
  const estimator=createEstimator(async url=>{calls++;return validFeed(url);});
  for(const season of ['2026/../2025','2026?x=1','26',2026,null,{},['2026'],'2026\n'])
    assert.deepEqual(await estimator({...league,season},6,rows),[null,null]);
  for(const week of [true,'6',0,19,1.5])
    assert.deepEqual(await estimator(league,week,rows),[null,null]);
  assert.equal(calls,0);
});

test('same week in different seasons has separate cached results',async()=>{
  let calls=0;
  const estimator=createEstimator(async url=>{
    calls++;
    const feed=validFeed(url.replaceAll('2025','2026'));
    if(!url.includes('2025'))return feed;
    if(Array.isArray(feed))return feed.map(p=>({...p,season:'2025',stats:{gp:1,rec:8}}));
    return {...feed,season:{year:2025},events:feed.events.map(e=>({...e,season:{year:2025}}))};
  },()=>100000);
  assert.equal((await estimator(league,6,rows))[0].points,15);
  assert.equal((await estimator({...league,season:'2025'},6,rows))[0].points,18);
  assert.equal((await estimator(league,6,rows))[0].points,15);
  assert.equal(calls,5);
});
