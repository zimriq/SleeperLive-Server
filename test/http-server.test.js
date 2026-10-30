import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {createHTTPServer} from '../http-server.js';
async function fixture(t,handler){
  const server=createHTTPServer(handler);
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return server.address().port;
}
function raw(port,request){
  return new Promise((resolve,reject)=>{
    const socket=connect(port,'127.0.0.1');let data='';
    const timer=setTimeout(()=>{socket.destroy();reject(Error('HTTP deadline was not enforced'));},38000);
    socket.setEncoding('utf8');
    socket.on('connect',()=>socket.write(request));
    socket.on('data',chunk=>data+=chunk);
    socket.on('error',error=>{clearTimeout(timer);reject(error);});
    socket.on('close',()=>{clearTimeout(timer);resolve(data);});
  });
}
test('oversized HTTP headers are rejected before application processing',async t=>{
  let requests=0;
  const port=await fixture(t,(_,res)=>{requests++;res.end('ok');});
  const response=await raw(port,'GET / HTTP/1.1\r\nHost: localhost\r\nX-Fill: '+'a'.repeat(17*1024)+'\r\nConnection: close\r\n\r\n');
  assert.match(response,/^HTTP\/1\.1 431 /);assert.equal(requests,0);
  const valid=await raw(port,'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  assert.match(valid,/^HTTP\/1\.1 200 /);assert.equal(requests,1);
});
test('real header and body upload deadlines close stalled connections', {timeout:40000},async t=>{
  let completed=0;
  const port=await fixture(t,(req,res)=>{
    req.on('error',()=>{});
    req.resume();req.on('end',()=>{completed++;res.end('ok');});
  });
  // These run simultaneously using the actual production deadlines, not shortened mocks.
  const [headers,body]=await Promise.all([
    raw(port,'GET / HTTP/1.1\r\nHost: localhost\r\nX-Incomplete: '),
    raw(port,'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n{'),
  ]);
  assert.match(headers,/^HTTP\/1\.1 408 /);
  assert.match(body,/^HTTP\/1\.1 408 /);
  assert.equal(completed,0);
  const healthy=await raw(port,'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  assert.match(healthy,/^HTTP\/1\.1 200 /);
});
