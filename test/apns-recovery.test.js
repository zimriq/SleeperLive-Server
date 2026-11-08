import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { generateKeyPairSync } from 'node:crypto';
import { createAPNs } from '../apns.js';
const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});
const cfg={mode:'live',key,keyId:'TEST',teamId:'TEAM',bundleId:'test.app'};
const message={env:'development',token:'private-token',event:'update',timestamp:1,state:{updatedAt:1}};
async function fixture(t,handler,options={}) {
  const server=http2.createServer(),sessions=new Set(),clients=[];
  server.on('session',s=>{sessions.add(s);s.on('error',()=>{});s.on('close',()=>sessions.delete(s));});
  server.on('stream',(stream,headers)=>{stream.on('error',()=>{});stream.resume();handler(stream,headers);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=createAPNs(cfg,Date.now,{connect:()=>{
    const s=http2.connect(`http://127.0.0.1:${server.address().port}`);clients.push(s);return s;
  },requestTimeoutMs:1000,sessionIdleMs:1000,...options});
  t.after(async()=>{client.close();for(const s of sessions)s.destroy();await new Promise(resolve=>server.close(resolve));});
  return {client,clients};
}
function respond(stream,status=200,reason){stream.respond({':status':status});stream.end(JSON.stringify({reason}));}

test('silent HTTP/2 connection times out, is destroyed, and next send reconnects',async t=>{
  let requests=0;
  const f=await fixture(t,stream=>{if(++requests>1)respond(stream);},{requestTimeoutMs:100});
  assert.equal((await f.client.send(message)).reason,'Timeout');
  assert.equal(f.clients[0].destroyed,true);
  assert.equal((await f.client.send(message)).kind,'ok');
  assert.equal(f.clients.length,2);
});

test('idle session is discarded and a later send opens a fresh connection',async t=>{
  const f=await fixture(t,stream=>respond(stream),{sessionIdleMs:30});
  assert.equal((await f.client.send(message)).kind,'ok');
  const first=f.clients[0];
  await Promise.race([new Promise(resolve=>first.once('close',resolve)),new Promise((_,reject)=>{
    const timer=setTimeout(()=>reject(Error('idle session did not close')),1000);timer.unref();
  })]);
  assert.equal((await f.client.send(message)).kind,'ok');assert.equal(f.clients.length,2);
});

test('identical APNs failures alert once per streak and reset after success',async t=>{
  const alerts=[];let status=403,reason='InvalidProviderToken';
  const f=await fixture(t,stream=>respond(stream,status,reason),{errorLog:record=>alerts.push(record)});
  for(let i=0;i<4;i++)assert.equal((await f.client.send(message)).kind,'retry');
  assert.deepEqual(alerts,[{event:'apns_repeated_failure',environment:'development',status:403,reason,consecutiveFailures:3}]);
  status=200;await f.client.send(message);status=400;reason='BadDeviceToken';
  for(let i=0;i<3;i++)assert.equal((await f.client.send(message)).kind,'retry');
  assert.equal(alerts.length,2);assert.equal(alerts[1].reason,'BadDeviceToken');
  assert.equal(JSON.stringify(alerts).includes(message.token),false);
});

test('failure streaks are separate per environment; 410 clears a streak and unknown reasons are hidden',async t=>{
  const alerts=[];let status=400,reason='private-token';
  const f=await fixture(t,stream=>respond(stream,status,reason),{errorLog:record=>alerts.push(record)});
  await f.client.send(message);await f.client.send(message);
  await f.client.send({...message,env:'production'});assert.equal(alerts.length,0);
  status=410;reason='Unregistered';assert.equal((await f.client.send(message)).kind,'dead');
  status=400;reason='private-token';
  await f.client.send(message);await f.client.send(message);assert.equal(alerts.length,0);
  await f.client.send(message);assert.equal(alerts.length,1);assert.equal(alerts[0].reason,'Other');
  assert.equal(JSON.stringify(alerts).includes('private-token'),false);
});
