import test from 'node:test';
import assert from 'node:assert/strict';
import { logInfo, logError } from '../logging.js';

test('routine events use stdout and failures use stderr as single JSON records',t=>{
  const info=[],errors=[],stdout=console.log,stderr=console.error;
  console.log=line=>info.push(line);console.error=line=>errors.push(line);
  t.after(()=>{console.log=stdout;console.error=stderr;});
  logInfo('event=registered activity=12345678');
  logError('poll_failed',Error('private database details'));
  assert.equal(info.length,1);assert.equal(errors.length,1);
  assert.equal(JSON.parse(info[0]).level,'info');
  assert.equal(JSON.parse(errors[0]).level,'error');
  assert.match(JSON.parse(errors[0]).stack,/logging.test.js/);
  assert.equal(errors[0].includes('private database details'),false);
  assert.equal(errors[0].includes('\n'),false);
});
