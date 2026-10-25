# Automatic enrollment — server checkpoint

Status: server and iOS client implemented; local server tests and the iOS development build pass. A real Apple attestation test and TestFlight push test remain required. Enrollment is disabled by default.
Existing invite enrollment, device credentials, and Live Activities continue working.

## Configuration

- `APP_ATTEST_ENABLED=false` by default. Disabled endpoints return 404.
- `APP_ATTEST_APP_ID_PREFIX`: verify the App ID Prefix in Apple Developer Identifiers.
  Do not assume it is the Team ID. Combined with `APNS_BUNDLE_ID` for verification.
- `APP_ATTEST_ALLOW_DEVELOPMENT=false`: production-only by default. TestFlight uses
  production App Attest. APNs environment is a separate setting.
- Existing `MAX_DEVICES` applies to BOTH invitation and automatic registrations.
  Existing registrations count toward this limit.

## Client contract

1. Generate an App Attest key and a cryptographically random 32-byte device secret.
   Encode the secret as 64 lowercase hex characters. Persist pending state securely
   before sending requests. Never ship a shared invite or APNs key in the client.
2. POST `/v1/enrollment/challenge` with:
   `{ "keyId": "<Apple key ID, canonical base64>", "credentialHash": "<SHA256 of UTF-8 hex secret, lowercase hex>" }`.
   Response 201: `{ "challengeId": "<32 hex chars>", "challenge": "<random base64 string>", "expiresAt": <Unix seconds> }`.
3. Hash the UTF-8 bytes of the returned **challenge string**, NOT base64-decoded bytes,
   with SHA256. Pass that hash to `DCAppAttestService.attestKey` as clientDataHash.
4. Persist the resulting proof while enrollment is pending. POST
   `/v1/enrollment/complete` with `{ "challengeId": "...", "attestation": "<base64 proof>" }`.
   Response 201 (or 200 on exact retry): `{ "deviceId": "..." }`.
5. Save `deviceToken = deviceId + "." + secret` into the existing Keychain credentials.
   Existing API bearer authentication then works without user-entered codes.
   Clear the pending proof/secret copy only after credentials are durably saved.

The raw device secret is never returned by the server or sent during enrollment.
A captured completion response only contains the public device ID. The server holds
its SHA256 hash, the attested public key/key ID and environment. It does not store
Apple receipts or full attestations. No sensitive enrollment payloads are logged.

## Retry, limits and failure behavior

- Challenges expire after five minutes and are invalidated by a server restart.
  An expired/missing challenge returns 410. The client must restart enrollment with
  a new App Attest key; a successful Apple attestation cannot simply be repeated
  against a different challenge with the same key. Avoid automatic tight retry loops.
- Exact completion retries within the challenge window return the same device ID.
  Different proof replays fail. A key cannot register twice, even after revocation.
- Invalid proofs consume the pending challenge. No automatic unverified fallback.
- 10 enrollment requests per IP/minute and 30 globally/minute; challenge and complete
  both count. At most 200 challenges reside in memory. Body limit is 32 KiB.
- Device caps are checked atomically on completion, including concurrent requests.
- Unsupported App Attest devices need an explicit support path in the next client
  checkpoint. Existing private invitation setup is retained, not silently bypassed.
- Attestation proves app/device integrity, not Sleeper account ownership or that a
  person was invited to TestFlight. It does not prevent a genuine app from making
  repeated installations; caps and rate limits remain necessary.
- Normal API calls continue using bearer credentials. Per-request App Attest
  assertions and automated lost-credential recovery are outside this checkpoint.

## Validation and rollout

`npm test` covers expired/invalid challenges, retry idempotency, replay/revocation,
concurrent device caps, production-vs-development policy, body/rate limits, disabled
configuration and compatibility with the existing API. State-transition success
cases inject a test verifier; the actual Apple verifier has malformed-input and
untrusted-certificate rejection tests. These do not establish real-device success.

Next: configure the verified App ID prefix and enable enrollment on Railway for a controlled physical-device test. Test authentic attestation and failed/retried registration. Keep the current invite path until migration is proven.

Verification dependency: pinned `node-app-attest` plus bounded `cbor` decoding;
additional checks enforce certificate validity dates, chain ordering, CA status,
P-256 leaf keys and attested-credential flags. Review dependency updates explicitly.

References:
- https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server
- https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity
- https://github.com/uebelack/node-app-attest

## TestFlight production pushes

Keep APNS_KEY_ID and APNS_KEY_P8 as the existing sandbox credentials. Add
APNS_PRODUCTION_KEY_ID and APNS_PRODUCTION_KEY_P8 for the production key.
For local use, APNS_PRODUCTION_KEY_FILE can supply a private file path instead.
Never commit either private key. Production activities select the production
signer; development activities keep the original signer. Without the optional
production pair, the existing single-key behavior is preserved.

GET /v1/devices/me requires bearer authentication and returns only deviceId,
with Cache-Control: no-store. The client uses it to recover a committed enrollment
after a lost response, even after the challenge expires or the server restarts.

Validation: 36 server tests pass, including environment-specific JWT signatures
and authenticated recovery. These are not proof of Apple accepting either key.
