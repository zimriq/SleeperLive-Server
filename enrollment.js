import express from 'express';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import cbor from 'cbor';
import { verifyAttestation } from 'node-app-attest';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const lifetime = 5 * 60 * 1000;

// The library checks Apple's trust anchor, nonce, app identity, key ID, counter,
// and environment. Also enforce bounded CBOR, certificate dates and key shape.
export function verifyAppleAttestation({ attestation, challenge, keyId, cfg, now }) {
  const decoded = cbor.decodeAllSync(attestation, { max_depth: 16, preventDuplicateKeys: true });
  if (decoded.length !== 1) throw Error('Invalid attestation');
  const object = decoded[0];
  if (object?.fmt !== 'apple-appattest' || object.attStmt?.x5c?.length !== 2 ||
      !Buffer.isBuffer(object.authData) || object.authData.length < 87 ||
      !(object.authData[32] & 0x40)) throw Error('Invalid attestation');
  const certificates = object.attStmt.x5c.map(bytes => {
    if (!Buffer.isBuffer(bytes)) throw Error('Invalid certificate');
    const cert = new X509Certificate(bytes);
    if (!(Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo))) throw Error('Expired certificate');
    return cert;
  });
  const [leaf, intermediate] = certificates;
  if (leaf.ca || !intermediate.ca || !leaf.checkIssued(intermediate) ||
      leaf.publicKey.asymmetricKeyType !== 'ec' ||
      leaf.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw Error('Invalid certificate chain');
  const result = verifyAttestation({ attestation, challenge, keyId,
    bundleIdentifier: cfg.bundleId, teamIdentifier: cfg.attestAppIdPrefix,
    allowDevelopmentEnvironment: cfg.attestAllowDevelopment === true });
  if (result.keyId !== keyId || !result.publicKey ||
      !['production', ...(cfg.attestAllowDevelopment ? ['development'] : [])].includes(result.environment)) {
    throw Error('Invalid verification result');
  }
  return result;
}

// A separate router keeps large attestation bodies away from the normal API.
// Challenges intentionally live only in bounded memory: a restart invalidates
// unfinished registrations, while committed devices survive in SQLite.
export function enrollmentRouter({ cfg, store, limit, now, verify = verifyAppleAttestation }) {
  const router = express.Router(), challenges = new Map();
  router.use((req, res, next) => {
    try {
      if (!cfg.attestEnabled) throw fail(404, 'not_found');
      limit('global:enrollment', 30);
      limit(`enrollment:${req.clientIP??req.ip}`, 10);
      res.set('Cache-Control', 'no-store');
      for (const [id, challenge] of challenges) if (challenge.expiresAt <= now()) challenges.delete(id);
      next();
    } catch (error) { next(error); }
  });
  router.use(express.json({ limit: '32kb', inflate: false }));
  router.post('/challenge', (req, res) => {
    const { keyId, credentialHash } = req.body ?? {};
    // Canonical base64 of Apple's 32-byte key identifier, and SHA256 of a
    // client-generated 32-byte random secret encoded as lowercase hex text.
    if (typeof keyId !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(keyId) ||
        Buffer.from(keyId, 'base64').toString('base64') !== keyId ||
        typeof credentialHash !== 'string' || !/^[a-f0-9]{64}$/.test(credentialHash)) {
      throw fail(400, 'invalid_enrollment');
    }
    if (challenges.size >= 200) throw fail(429, 'enrollment_busy');
    const devices = Object.values(store.read().devices);
    if (devices.filter(d => !d.revoked).length >= cfg.maxDevices) throw fail(503, 'device_limit');
    if (devices.some(d => d.attestKeyId === keyId)) throw fail(409, 'key_already_registered');
    const challengeId = randomBytes(16).toString('hex');
    const challenge = randomBytes(32).toString('base64');
    const expiresAt = now() + lifetime;
    challenges.set(challengeId, { keyId, credentialHash, challenge, expiresAt });
    res.status(201).json({ challengeId, challenge, expiresAt: Math.floor(expiresAt / 1000) });
  });
  router.post('/complete', (req, res) => {
    const { challengeId, attestation } = req.body ?? {};
    if (typeof challengeId !== 'string' || !/^[a-f0-9]{32}$/.test(challengeId) ||
        typeof attestation !== 'string' || attestation.length < 4 || attestation.length > 28000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(attestation)) throw fail(400, 'invalid_enrollment');
    const bytes = Buffer.from(attestation, 'base64');
    if (bytes.toString('base64') !== attestation) throw fail(400, 'invalid_enrollment');
    const pending = challenges.get(challengeId);
    if (!pending) throw fail(410, 'challenge_expired');
    const proofHash = hash(bytes);
    if (pending.completedProof) {
      const device = store.read().devices[challengeId];
      if (pending.completedProof !== proofHash || !device || device.revoked) throw fail(403, 'invalid_attestation');
      // Lost HTTP responses may be retried without creating another device.
      // No bearer secret is returned: only the originating client knows it.
      return res.status(200).json({ deviceId: challengeId });
    }
    let verified;
    try {
      verified = verify({ attestation: bytes, challenge: pending.challenge,
        keyId: pending.keyId, cfg, now: now() });
      if (verified.keyId !== pending.keyId || typeof verified.publicKey !== 'string' ||
          !['production', ...(cfg.attestAllowDevelopment ? ['development'] : [])].includes(verified.environment)) throw Error();
    } catch {
      challenges.delete(challengeId);
      throw fail(403, 'invalid_attestation');
    }
    store.change(state => {
      const devices = Object.values(state.devices);
      if (devices.some(d => d.attestKeyId === pending.keyId)) throw fail(409, 'key_already_registered');
      if (devices.filter(d => !d.revoked).length >= cfg.maxDevices) throw fail(503, 'device_limit');
      state.devices[challengeId] = { hash: pending.credentialHash, createdAt: Math.floor(now() / 1000),
        attestKeyId: pending.keyId, attestPublicKey: verified.publicKey,
        attestEnvironment: verified.environment };
    });
    pending.completedProof = proofHash;
    res.status(201).json({ deviceId: challengeId });
  });
  return router;
}
