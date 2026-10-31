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
