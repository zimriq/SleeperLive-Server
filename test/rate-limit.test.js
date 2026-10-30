import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../rate-limit.js';
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
