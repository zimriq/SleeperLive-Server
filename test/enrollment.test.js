import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import cbor from 'cbor';
import { enrollmentRouter, verifyAppleAttestation } from '../enrollment.js';
import { openStore } from '../registrations.js';
import { createApp } from '../app.js';
import { config } from '../config.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const cfg = { attestEnabled: true, attestAllowDevelopment: false,
  attestAppIdPrefix: 'ABCDEFGHIJ', bundleId: 'com.example.test',
  maxDevices: 12, invite: 'test-private-invitation-at-least-24', mode: 'dry-run' };
const proof = Buffer.from('test-proof').toString('base64');
// Injected verifier only tests enrollment state transitions. Production uses
// verifyAppleAttestation; these fixtures do NOT stand in for an Apple device test.
async function fixture(t, options = {}) {
  let time = 1800000000000, verified = 0;
  const store = openStore(':memory:'), app = express();
  app.use('/v1/enrollment', enrollmentRouter({ cfg: { ...cfg, ...options.cfg }, store,
    now: () => time, limit: () => {}, verify: input => {
      verified++;
      if (input.attestation.toString() !== 'test-proof' || options.reject) throw Error('rejected');
      return { keyId: input.keyId, publicKey: 'test-only-public-key', environment: options.environment ?? 'production' };
    } }));
  app.use((e, req, res, next) => res.status(e.status ?? 500).json({error: e.message}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}/v1/enrollment/${path}`,
    {method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body)});
  async function challenge(keyId = randomBytes(32).toString('base64'), secret = randomBytes(32).toString('hex')) {
    const response = await post('challenge', {keyId, credentialHash: hash(secret)});
    return {response, ...(await response.json()), keyId, secret};
  }
  return {store, post, challenge, advance: ms => time += ms, count: () => verified};
}

test('attested enrollment stores only a hash and retry returns same device without re-verifying', async t => {
  const f = await fixture(t), c = await f.challenge();
  assert.equal(c.response.status, 201);
  const body = {challengeId: c.challengeId, attestation: proof};
  const first = await f.post('complete', body), retry = await f.post('complete', body);
  assert.equal(first.status, 201); assert.equal(retry.status, 200);
  assert.deepEqual(await first.json(), {deviceId: c.challengeId});
  assert.deepEqual(await retry.json(), {deviceId: c.challengeId});
  assert.equal(f.count(), 1);
  const state = f.store.read();
  assert.equal(Object.keys(state.devices).length, 1);
  assert.equal(state.devices[c.challengeId].hash, hash(c.secret));
  assert.equal(JSON.stringify(state).includes(c.secret), false);
  assert.equal((await f.post('complete', {...body, attestation: Buffer.from('other-proof').toString('base64')})).status, 403);
  // Verify compatibility with the existing bearer-authenticated API.
  const app = createApp({cfg, store: f.store, sleeper: {}}), server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/activities/missing`,
    {headers: {authorization: `Bearer ${c.challengeId}.${c.secret}`}});
  assert.equal(response.status, 404); // authenticated, but no such activity
});

test('invalid proof consumes the challenge and cannot create a device', async t => {
  const f = await fixture(t, {reject: true}), c = await f.challenge();
  const body = {challengeId: c.challengeId, attestation: proof};
  assert.equal((await f.post('complete', body)).status, 403);
  assert.equal((await f.post('complete', body)).status, 410);
  assert.deepEqual(f.store.read().devices, {});
});
test('expired challenges are rejected before cryptographic work', async t => {
  const f = await fixture(t), c = await f.challenge(); f.advance(300000);
  assert.equal((await f.post('complete', {challengeId: c.challengeId, attestation: proof})).status, 410);
  assert.equal(f.count(), 0);
});
test('concurrent completions cannot exceed device cap or register one key twice', async t => {
  const f = await fixture(t, {cfg: {maxDevices: 1}}), a = await f.challenge(), b = await f.challenge();
  const result = await Promise.all([a,b].map(c => f.post('complete', {challengeId: c.challengeId, attestation: proof})));
  assert.deepEqual(result.map(r => r.status).sort(), [201,503]);
  assert.equal(Object.keys(f.store.read().devices).length, 1);
  const g = await fixture(t), c = await g.challenge(), d = await g.challenge(c.keyId);
  assert.equal((await g.post('complete', {challengeId: c.challengeId, attestation: proof})).status, 201);
  assert.equal((await g.post('complete', {challengeId: d.challengeId, attestation: proof})).status, 409);
  assert.equal(Object.keys(g.store.read().devices).length, 1);
});
test('revocation blocks successful enrollment replay', async t => {
  const f = await fixture(t), c = await f.challenge(), body = {challengeId: c.challengeId, attestation: proof};
  await f.post('complete', body);
  f.store.change(s => s.devices[c.challengeId].revoked = true);
  assert.equal((await f.post('complete', body)).status, 403);
  assert.equal((await f.challenge(c.keyId)).response.status, 409);
});
test('production enrollment rejects development proofs unless explicitly enabled', async t => {
  const f = await fixture(t, {environment: 'development'}), c = await f.challenge();
  assert.equal((await f.post('complete', {challengeId: c.challengeId, attestation: proof})).status, 403);
  const g = await fixture(t, {environment: 'development', cfg: {attestAllowDevelopment: true}}), d = await g.challenge();
  assert.equal((await g.post('complete', {challengeId: d.challengeId, attestation: proof})).status, 201);
});
test('disabled and malformed enrollment fail closed; bodies are bounded', async t => {
  const f = await fixture(t, {cfg: {attestEnabled: false}});
  assert.equal((await f.challenge()).response.status, 404);
  const g = await fixture(t);
  assert.equal((await g.post('challenge', {keyId: 'bad', credentialHash: 'bad'})).status, 400);
  assert.equal((await g.post('complete', {challengeId: 'a'.repeat(32), attestation: '!!!!'})).status, 400);
  assert.equal((await g.post('complete', {attestation: 'a'.repeat(40000)})).status, 413);
  assert.equal(g.count(), 0);
});
test('public enrollment has global and per-IP request limits', async t => {
  const store = openStore(':memory:'), app = createApp({cfg, store, sleeper: {}});
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => {await new Promise(r => server.close(r)); store.close();});
  const url = `http://127.0.0.1:${server.address().port}/v1/enrollment/challenge`;
  const codes = [];
  for (let i=0; i<11; i++) codes.push((await fetch(url, {method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status);
  assert.equal(codes.at(-1), 429);
  // Even changing client IPs cannot avoid the global verification-work budget.
  let last;
  for (let i=0; i<20; i++) last = await fetch(url, {method:'POST',
    headers:{'content-type':'application/json', 'x-forwarded-for':`192.0.2.${i+1}`},body:'{}'});
  assert.equal(last.status, 429);
});
test('real verifier rejects garbage, wrong format, deeply nested CBOR and untrusted certificates', () => {
  let nested = 'x'; for(let i=0;i<25;i++) nested=[nested];
  const badCerts = {fmt:'apple-appattest', authData:Buffer.alloc(90),attStmt:{x5c:[Buffer.from('fake'),Buffer.from('fake')]}};
  badCerts.authData[32] = 0x40;
  for (const attestation of [Buffer.from('garbage'),cbor.encode({}),cbor.encode(nested),cbor.encode(badCerts)]) {
    assert.throws(() => verifyAppleAttestation({attestation,challenge:'challenge',keyId:'bad',cfg,now:Date.now()}));
  }
});
test('configuration defaults off and requires explicit app identity when enabled', () => {
  assert.equal(config({INVITE_CODE:cfg.invite}).attestEnabled, false);
  assert.throws(() => config({INVITE_CODE:cfg.invite,APP_ATTEST_ENABLED:'yes'}));
  assert.throws(() => config({INVITE_CODE:cfg.invite,APP_ATTEST_ENABLED:'true'}));
  const valid = config({INVITE_CODE:cfg.invite,APP_ATTEST_ENABLED:'true',APP_ATTEST_APP_ID_PREFIX:'ABCDEFGHIJ',APNS_BUNDLE_ID:'com.example.test'});
  assert.equal(valid.attestAllowDevelopment, false);
});
