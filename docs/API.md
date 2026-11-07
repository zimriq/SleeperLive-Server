# API and app integration

[Back to README](../README.md)

## HTTP API and iOS integration

Use HTTPS for remote connections. JSON uses camelCase. All dates are Int Unix seconds.
Store device credentials in Keychain; never put the APNs signing key in the app.
The app creates an ActivityKit Live Activity with pushType .token; no push-to-start.

### Legacy private enrollment

`INVITE_ENROLLMENT_ENABLED` explicitly enables or disables new invitation
registrations. If unset, it defaults to false when `APP_ATTEST_ENABLED=true`, and
true otherwise for compatibility with private local testing. Disabled enrollment
returns 404 even if `INVITE_CODE` is present and correct. A secret of at least 24
characters is required only when invitation enrollment is enabled. Responses from
this route use `Cache-Control: no-store`, including successful credential creation.
Existing device tokens remain valid until revoked; disabling invitations does not
interrupt their activity registration or updates. An explicit true override should
be reserved for deliberate private testing, since it bypasses App Attest enrollment.

POST /v1/devices
Body: {"inviteCode":"the invite entered by the tester"}
Response 201: {"deviceId":"...", "deviceToken":"..."}

All following endpoints require Authorization: Bearer <deviceToken>.
A 401 means reenrollment is needed. A 429 is rate-limited; honor Retry-After.
Invite codes are for private tests. Automatic App Attest enrollment is described below.

### Initial and refreshed matchup

GET /v1/matchup?leagueId=123456789&week=6&rosterId=4

Response:
```json
{
  "attributes": {
    "leagueName": "My League",
    "yourName": "My Team",
    "opponentName": "Other Team",
    "week": 6
  },
  "state": {
    "yourScore": 42.5,
    "opponentScore": 51.25,
    "yourProjected": null,
    "opponentProjected": null,
    "yourProjectionKind": "unavailable",
    "opponentProjectionKind": "unavailable",
    "updatedAt": 1791948000
  }
}
```

Swift attributes contain leagueName/yourName/opponentName (String), week (Int).
ContentState contains scores (Double), projections (Double?), projection kinds
(String or a matching Codable enum), and updatedAt (Int). Convert to Date with
Date(timeIntervalSince1970: TimeInterval(updatedAt)). No custom Date decoding.
Kinds: estimate, final, unavailable. Show null projections as "Proj. —"; label available estimates "Proj.". Explain in the app that estimates are experimental, not official Sleeper live projections.

Use this same server state for the app and initial Activity content. For initial
content also set staleDate to updatedAt + 360. The app can retain its existing
Sleeper account/league/roster discovery; use this endpoint for the authoritative
matchup display once connected. A missing opponent/upstream failure currently
returns 503 matchup_unavailable; don't start an activity with no valid snapshot.

### Register and rotate

PUT /v1/activities/<Activity.id>
```json
{
  "leagueId": "123456789",
  "week": 6,
  "rosterId": 4,
  "pushToken": "hex encoded activity push token",
  "apnsEnvironment": "development",
  "startedAt": 1791948000
}
```

startedAt is when the app actually requested the activity, not when token registration
finally succeeds. Persist it alongside the activity ID. Retry transient registration
failures; subscribe to pushTokenUpdates and PUT on every token change. Sequential
registration per activity avoids sending token changes in the wrong order. Identity
and startedAt cannot change on retries. Response 201 (new) or 200 (existing) includes
activityId and expiresAt. 409 means ended or mismatched identity; stop retrying that
request unchanged. Token rotation never extends lifetime.

Environment must match the signed app's aps-environment entitlement: development
uses sandbox; distribution normally production. Build configuration alone is not
proof. The first push arrives on the next server polling cycle, not instantly.

### Read or end

GET /v1/activities/<id> returns status, attributes, state, expiresAt, lastAcceptedAt.
State is the initial snapshot or latest successful APNs submission, not proof of
phone delivery. To get freshly fetched scores, use GET /v1/matchup.

End locally with ActivityKit, then DELETE /v1/activities/<id> (204, idempotent).
Retry deletion if offline; server expiry bounds abandoned registrations.
DELETE /v1/devices/me revokes this device and requests end pushes for its activities.

### Ordering and freshness

updatedAt describes score-data freshness. When merging server snapshots in the app,
ignore older updatedAt values within the SAME league/week/roster selection. Cancel or
ignore requests from an old selection. Equal timestamps are allowed and may contain
new projection data. No artificial per-activity revision is mixed with preview data.
APNs ordering uses aps.timestamp (send time reserved durably, increasing per activity).
The app's optional local Activity.update calls must use compatible timestamps;
prefer server pushes for active activities rather than racing local/push updates.

Show ActivityViewContext.isStale in the widget. Starting and ending must handle
Live Activities disabled, missing tokens, user dismissal, registration failure,
and the eight-hour lifecycle. Polling does not mean guaranteed 75-second delivery.

## Automatic enrollment

### Configuration

- `APP_ATTEST_ENABLED=false` by default. Disabled endpoints return 404.
- `APP_ATTEST_APP_ID_PREFIX`: verify the App ID Prefix in Apple Developer Identifiers.
  Do not assume it is the Team ID. Combined with `APNS_BUNDLE_ID` for verification.
- `APP_ATTEST_ALLOW_DEVELOPMENT=false`: production-only by default. TestFlight uses
  production App Attest. APNs environment is a separate setting.
- Existing `MAX_DEVICES` applies to BOTH invitation and automatic registrations.
  Existing registrations count toward this limit.

### Client contract

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

### Retry, limits and failure behavior

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
- Unsupported App Attest devices cannot use automatic enrollment. Private
  invitation setup requires the policy above; there is no automatic fallback.
- Attestation proves app/device integrity, not Sleeper account ownership or that a
  person was invited to TestFlight. It does not prevent a genuine app from making
  repeated installations; caps and rate limits remain necessary.
- Normal API calls continue using bearer credentials; per-request App Attest
  assertions are not implemented.

### Credential recovery and push environments

`GET /v1/devices/me` requires bearer authentication, returns `deviceId`, and sets
`Cache-Control: no-store`. The client can use it to recover an enrollment that
committed before its response was lost, even after challenge expiry or restart.

Use `APNS_KEY_ID` with `APNS_KEY_P8` or `APNS_KEY_FILE` for the default signer.
An optional separate production signer uses `APNS_PRODUCTION_KEY_ID` with
`APNS_PRODUCTION_KEY_P8` or `APNS_PRODUCTION_KEY_FILE`. Both production values
must be present together. Production activities select that signer when supplied;
otherwise the default signer is used. A signing key must support the requested
APNs environment. Never include private keys in Git or the iOS app.

## Recovery contract (develop, November 6, 2026)

`awaiting_token` registrations are paused, not ended. They do not fetch Sleeper
or send pushes, still occupy device/global capacity, and expire at their original
deadline. Re-uploading the same invalid token/environment returns 200 with
`needsPushToken: true`, without changing the record. A different token or environment
revives delivery. Duplicate uploads do not clear backoff; only `refresh: true`
from an intentional user/foreground refresh requests that reset.

GET `/v1/activities/:id` retains all prior fields and adds `needsPushToken`,
`endedReason`, and `endedAt` (Unix seconds or null). Existing owned ended/expired
registrations return 409 `activity_ended` before start-age validation; invalid
start times for new registrations remain 400. Reasons are `expired`, `user_delete`,
`device_revoked`, `device_data_deleted`, `apns_unregistered`, `end_push_accepted`,
and `end_push_failed`. Data deletion removes the record, so its reason survives
only in the sanitized event log. `endReason` remains as a compatibility alias.

Events use `event=<name> activity=<first 8 characters> reason=<value>`; token-loss
and push-result events can include APNs status. No push token, bearer credential,
full activity ID, or device ID is emitted by these application events. Railway's
incoming HTTP access logs are separate and may contain full URL paths.

Deploy the server before an app build that depends on this recovery contract.
The app main source checked locally does not GET/decode activity status; registration
accepts any 2xx and ignores the response body. Exact approved/TestFlight binary
provenance and physical-device compatibility still require verification. Dry-run
cannot verify actual APNs delivery, token rotation, or locked-phone recovery.
