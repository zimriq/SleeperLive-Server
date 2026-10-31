import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, createApiRateLimiter } from '../rate-limit.js';
const blocked = action => assert.throws(action, {status:429, message:'rate_limited'});

test('independent counters reset at the exact boundary without sliding on hits',()=>{
  let time=0;
  const limit=createRateLimiter(()=>time);
  limit('a',2);
  time=10000;limit('b',1);
  time=59999;limit('a',2);blocked(()=>limit('a',2));
  time=60000;limit('a',2);blocked(()=>limit('b',1));
  time=70000;limit('b',1);
});

test('full counter storage protects existing budgets and reclaims only expired entries',()=>{
  let time=0;
  const limit=createRateLimiter(()=>time);
  for(let i=0;i<2500;i++)limit(`old:${i}`,2);
  time=10000;
  for(let i=0;i<2500;i++)limit(`new:${i}`,2);
  blocked(()=>limit('overflow',1));
  limit('new:0',2);blocked(()=>limit('new:0',2));
  time=60000;
  for(let i=0;i<2500;i++)limit(`replacement:${i}`,1);
  blocked(()=>limit('overflow',1));
  blocked(()=>limit('new:0',2));
  time=70000;limit('overflow',1);
  blocked(()=>limit('replacement:0',1));
});

test('backward clock movement cannot bypass limits or break expiration order',()=>{
  let time=100000;
  const limit=createRateLimiter(()=>time);
  limit('a',1);
  time=90000;limit('b',1);blocked(()=>limit('a',1));
  time=150000;blocked(()=>limit('b',1));
  time=160000;limit('a',1);limit('b',1);
});


test('enrollment counter saturation cannot consume authenticated or global capacity',()=>{
  let time=0;
  const limit=createApiRateLimiter(()=>time);
  for(let i=0;i<3998;i++)limit(`${i%2?'ip':'enrollment'}:address${i}`,10);
  blocked(()=>limit('ip:overflow',10));
  for(let i=0;i<1000;i++)limit(`device:${i}`,30);
  limit('global:enrollment',30);limit('global:upstream',60);
  // Separate global budgets and existing IP/device counters still enforce limits.
  for(let i=1;i<30;i++)limit('global:enrollment',30);
  blocked(()=>limit('global:enrollment',30));
  limit('global:upstream',60);
  for(let i=1;i<30;i++)limit('device:0',30);
  blocked(()=>limit('device:0',30));
  limit('device:1',30);
  time=60000;
  limit('ip:overflow',10);limit('device:0',30);limit('global:enrollment',30);
});

test('device counter saturation cannot consume enrollment or global capacity',()=>{
  const limit=createApiRateLimiter(()=>0);
  for(let i=0;i<1000;i++)limit(`device:${i}`,30);
  blocked(()=>limit('device:overflow',30));
  limit('ip:new',10);limit('enrollment:new',10);
  limit('global:enrollment',30);limit('global:upstream',60);
  assert.throws(()=>limit('unexpected:key',1),/Unknown rate-limit category/);
});
