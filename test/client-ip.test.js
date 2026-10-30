import test from 'node:test';
import assert from 'node:assert/strict';
import {clientIP} from '../client-ip.js';
import {config} from '../config.js';
function request(value,raw){return {socket:{remoteAddress:'::ffff:192.0.2.8'},rawHeaders:raw??(value?['X-Real-IP',value]:[]),get:()=>value};}
test('direct connections ignore every caller-supplied IP header',()=>{
  assert.equal(clientIP(request('203.0.113.9')),'192.0.2.8');
});
test('Railway public mode validates a single canonical address',()=>{
  assert.equal(clientIP(request('2001:0db8:0:0:0:0:0:1'),'railway-public'),'2001:db8::1');
  assert.equal(clientIP(request('::ffff:192.0.2.8'),'railway-public'),'192.0.2.8');
  for(const value of [undefined,'garbage','192.0.2.1, 192.0.2.2','192.0.2.1:80','fe80::1%eth0']){
    assert.throws(()=>clientIP(request(value),'railway-public'),{status:400});
  }
  assert.throws(()=>clientIP(request('192.0.2.1',['X-Real-IP','192.0.2.1','x-real-ip','192.0.2.2']),'railway-public'),{status:400});
});
test('client IP mode defaults direct and rejects misspelled settings',()=>{
  const base={INVITE_ENROLLMENT_ENABLED:'false'};
  assert.equal(config(base).clientIPMode,'direct');
  assert.equal(config({...base,CLIENT_IP_MODE:'railway-public'}).clientIPMode,'railway-public');
  assert.throws(()=>config({...base,CLIENT_IP_MODE:'true'}));
});
