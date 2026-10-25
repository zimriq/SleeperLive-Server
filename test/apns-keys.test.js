import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createAPNs } from '../apns.js';
import { config } from '../config.js';

test('APNs selects and signs with the correct environment key', async t => {
  const sandbox = generateKeyPairSync('ec', {namedCurve:'prime256v1'});
  const production = generateKeyPairSync('ec', {namedCurve:'prime256v1'});
  const pem = pair => pair.privateKey.export({type:'pkcs8',format:'pem'});
  const requests = [];
  t.mock.method(http2, 'connect', host => {
    const session = new EventEmitter();
    session.destroy = session.close = () => {};
    session.request = headers => {
      requests.push({host,headers});
      const req = new EventEmitter();
      req.setEncoding = req.close = () => {};
      req.end = () => queueMicrotask(() => {req.emit('response',{':status':200});req.emit('end');});
      return req;
    };
    return session;
  });
  const client = createAPNs({mode:'live',key:pem(sandbox),keyId:'SANDBOX',productionKey:pem(production),productionKeyId:'PRODUCTION',teamId:'TEAM',bundleId:'test.app'});
  t.after(() => client.close());
  for (const env of ['development','production','development']) {
    assert.equal((await client.send({env,token:'test',event:'update',timestamp:1,state:{updatedAt:1}})).kind,'ok');
  }
  requests.forEach(({host,headers}, index) => {
    const prod = index === 1;
    assert.equal(host,prod?'https://api.push.apple.com':'https://api.sandbox.push.apple.com');
    const [head,body,signature] = headers.authorization.slice(7).split('.');
    assert.equal(JSON.parse(Buffer.from(head,'base64url')).kid,prod?'PRODUCTION':'SANDBOX');
    assert.ok(verify('sha256',Buffer.from(`${head}.${body}`),{key:(prod?production:sandbox).publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')));
  });
});

test('production credentials must be supplied as a complete pair', () => {
  const base = {INVITE_CODE:'test-secret-at-least-24-characters'};
  assert.throws(() => config({...base,APNS_PRODUCTION_KEY_ID:'key'}));
  assert.throws(() => config({...base,APNS_PRODUCTION_KEY_P8:'pem'}));
  assert.equal(config({...base,APNS_PRODUCTION_KEY_ID:'key',APNS_PRODUCTION_KEY_P8:'a\\nb'}).productionKey,'a\nb');
});
