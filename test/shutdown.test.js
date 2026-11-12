import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';

const preload = `
  import { Server } from 'node:http';
  const listen = Server.prototype.listen;
  Server.prototype.listen = function(port,callback) {
    this.once('listening',()=>process.send({port:this.address().port}));
    return listen.call(this,0,'127.0.0.1',callback);
  };
  let release;
  const gate = new Promise(resolve=>{release=resolve;});
  process.on('message',message=>{
    if (message==='release') { release(); process.disconnect(); }
    if (message==='throw') setImmediate(()=>{throw Error('private crash diagnostic');});
    if (message==='reject') Promise.reject(Error('private crash diagnostic'));
  });
  globalThis.fetch=async url=>{
    if (url.includes('/matchups/')) {
      process.send('upstream_started');
      await gate;
      return Response.json([{roster_id:1,matchup_id:1,points:10},{roster_id:2,matchup_id:1,points:20}]);
    }
    if (url.endsWith('/users') || url.endsWith('/rosters')) return Response.json([]);
    return Response.json({name:'Test league',season:'2026'});
  };
`;

async function fixture(t) {
  const invite='shutdown-test-invite-long-enough';
  const child=fork(new URL('../server.js',import.meta.url),[],{
    execArgv:['--import','data:text/javascript;base64,'+Buffer.from(preload).toString('base64')],
    env:{APNS_MODE:'dry-run',DB_PATH:':memory:',INVITE_CODE:invite},
    stdio:['ignore','pipe','pipe','ipc'],
  });
  const closed=once(child,'close');
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');await closed;});
  let stdout='',stderr='',notify;
  const draining=new Promise(resolve=>{notify=resolve;});
  child.stdout.on('data',chunk=>{
    stdout+=chunk;
    if(stdout.includes('event=shutdown_started'))notify();
  });
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const [{port}]=await Promise.race([
    once(child,'message'),
    closed.then(()=>{throw Error('Server exited before startup: '+stderr);}),
  ]);
  return {child,closed,draining,invite,root:`http://127.0.0.1:${port}`,
    stdout:()=>stdout,stderr:()=>stderr};
}

test('SIGTERM drains an accepted HTTP request and exits successfully',{timeout:10000},async t=>{
  const f=await fixture(t);
  const enrolled=await fetch(f.root+'/v1/devices',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({inviteCode:f.invite})});
  assert.equal(enrolled.status,201);
  const {deviceToken}=await enrolled.json();
  const started=once(f.child,'message');
  const response=fetch(f.root+'/v1/matchup?leagueId=123456789&week=6&rosterId=1',
    {headers:{authorization:`Bearer ${deviceToken}`}});
  response.catch(()=>{});
  const [message]=await started;
  assert.equal(message,'upstream_started');
  f.child.kill('SIGTERM');
  await f.draining;
  f.child.send('release');
  const reply=await response;
  assert.equal(reply.status,200);
  assert.equal((await reply.json()).state.yourScore,10);
  assert.deepEqual(await f.closed,[0,null]);
  assert.match(f.stdout(),/event=shutdown_complete/);
});

for (const [message,event] of [['throw','uncaught_exception'],['reject','unhandled_rejection']]) {
  test(`${event} logs a safe diagnostic and exits with failure`,{timeout:10000},async t=>{
    const f=await fixture(t);
    f.child.send(message);
    assert.deepEqual(await f.closed,[1,null]);
    const record=f.stderr().trim().split('\n').filter(line=>line.startsWith('{')).map(JSON.parse).at(-1);
    assert.equal(record.event,event);
    assert.equal(record.level,'error');
    assert.match(record.stack,/\bat\b/);
    assert.equal(f.stderr().includes('private crash diagnostic'),false);
  });
}
