import test from 'node:test';
import assert from 'node:assert/strict';
import { getJSON } from '../sleeper.js';

const url='https://api.sleeper.app/v1/league/123456789';
function streamResponse(parts,headers={}){
  let index=0,cancelled=false;
  const body=new ReadableStream({
    pull(controller){if(index<parts.length)controller.enqueue(parts[index++]);else controller.close();},
    cancel(){cancelled=true;}
  },{highWaterMark:0});
  return {response:new Response(body,{headers}),cancelled:()=>cancelled};
}

test('upstream JSON handles split Unicode and keeps the existing timeout signal',async()=>{
  const bytes=Buffer.from(JSON.stringify({name:'José 🏈'}));
  const stream=streamResponse(Array.from(bytes,b=>Uint8Array.of(b)));
  let signal;
  assert.deepEqual(await getJSON(url,{fetchImpl:async(_,options)=>{signal=options.signal;return stream.response;}}),{name:'José 🏈'});
  assert.ok(signal instanceof AbortSignal);
  assert.equal(stream.cancelled(),false);
});

test('oversized upstream bodies are cancelled regardless of declared length',async()=>{
  for(const headers of [{},{'content-length':'1'}]){
    const stream=streamResponse([Buffer.alloc(8*1024*1024,32),Buffer.from('0'),Buffer.from('unread')],headers);
    await assert.rejects(getJSON(url,{fetchImpl:async()=>stream.response}),/response too large/);
    assert.equal(stream.cancelled(),true);
  }
});

test('player catalog has a larger bounded allowance, other feeds keep the normal limit',async()=>{
  const bytes=Buffer.from(' '.repeat(8*1024*1024)+'{}');
  assert.deepEqual(await getJSON('https://api.sleeper.app/v1/players/nfl',{fetchImpl:async()=>new Response(bytes)}),{});
  const stream=streamResponse([Buffer.alloc(32*1024*1024,32),Buffer.from('0')]);
  await assert.rejects(getJSON('https://api.sleeper.app/v1/players/nfl',{fetchImpl:async()=>stream.response}),/response too large/);
  assert.equal(stream.cancelled(),true);
});

test('upstream failures cancel unused bodies and invalid JSON is rejected',async()=>{
  let cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}},{highWaterMark:0});
  await assert.rejects(getJSON(url,{fetchImpl:async()=>new Response(body,{status:503})}),/Upstream status 503/);
  assert.equal(cancelled,true);
  await assert.rejects(getJSON(url,{fetchImpl:async()=>new Response('{invalid')}),SyntaxError);
  const broken=new ReadableStream({pull(controller){controller.error(new Error('stream interrupted'));}});
  await assert.rejects(getJSON(url,{fetchImpl:async()=>new Response(broken)}),/stream interrupted/);
});

// Use real cache and limiter behavior without contacting Sleeper.
const { createSleeper } = await import('../sleeper.js');
function leagueLoader(counter) {
  return async url => {
    counter.calls++;
    if (url.includes('/matchups/')) return [{roster_id:1,matchup_id:1,points:10},{roster_id:2,matchup_id:1,points:20}];
    if (url.endsWith('/rosters') || url.endsWith('/users')) return [];
    return {season:'2026',name:'League'};
  };
}

test('cache hits and concurrent callers spend only physical upstream requests',async()=>{
  const counter={calls:0};let charged=0;
  const api=createSleeper(leagueLoader(counter),()=>0,{onFetch:()=>{charged++;}});
  await Promise.all(Array.from({length:60},()=>Promise.all([api.matchups('123456789',6),api.meta('123456789')])));
  assert.equal(counter.calls,4);assert.equal(charged,4);
  await api.matchups('987654321',6);
  assert.equal(counter.calls,5);assert.equal(charged,5);
});

test('exhausted upstream allowance serves stale values without refreshing timestamps and resets',async()=>{
  const counter={calls:0};let time=0;
  const api=createSleeper(leagueLoader(counter),()=>time);
  const first=await api.matchups('123456789',6);
  await api.meta('123456789');
  for(let i=0;i<56;i++)await api.matchups(String(200000000+i),6);
  assert.equal(counter.calls,60);
  time=5000;
  assert.deepEqual(await api.matchups('123456789',6),first);
  assert.equal(counter.calls,60);
  await assert.rejects(api.matchups('999999999',6),{code:'UPSTREAM_RATE_LIMITED'});
  time=60000;
  assert.equal((await api.matchups('123456789',6)).updatedAt,60);
  assert.equal(counter.calls,61);
});

test('metadata budget counts three fetches and stale fallback is limited to budget exhaustion',async()=>{
  const counter={calls:0};let time=0;
  const api=createSleeper(leagueLoader(counter),()=>time);
  const original=await api.meta('123456789');
  time=300000;
  for(let i=0;i<60;i++)await api.matchups(String(200000000+i),6);
  assert.deepEqual(await api.meta('123456789'),original);
  assert.equal(counter.calls,63);
  let fail=false;
  const broken=createSleeper(async()=>{if(fail)throw Error('network failure');return [];},()=>time);
  await broken.matchups('123456789',6);fail=true;time+=5000;
  await assert.rejects(broken.matchups('123456789',6),/network failure/);
});
