# SleeperLive server

Small, single-instance Node.js server for Sleeper fantasy matchup Live Activities.
It keeps device credentials and activities in SQLite, shares Sleeper requests across
users, and sends score changes and freshness heartbeats through APNs.

## Status

The iOS app and server have been exercised on real devices through TestFlight,
including live-game score updates, according to tester reports. This is functional
validation, not completion of the ongoing security review.

Requires Node.js 24+ for built-in SQLite. Dependencies are Express, cbor, and
node-app-attest. The server supports automatic App Attest enrollment, configurable legacy private
invite enrollment, durable registrations, token rotation, score-change pushes,
retry backoff, activity expiry, and optional experimental estimates.
No big-play alerts, avatars, or win probabilities are provided.

## Local setup

1. Run `npm ci`.
2. Copy `.env.example` to `.env`. Do not overwrite an existing `.env`.
3. Generate an invite secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   and set it as `INVITE_CODE`. Never commit it or embed it in a public app binary.
4. Run `npm test`, then `npm start`.
5. `GET http://localhost:3000/health` should report `mode: dry-run`.

Dry-run exercises polling/storage but DOES NOT deliver pushes. `lastAcceptedAt` in
this mode means simulated acceptance. With APNs live mode it means Apple accepted
our request, not proof that the phone displayed it.

For real pushes set `APNS_MODE=live`, `APNS_TEAM_ID`, `APNS_KEY_ID`, and the app's
`APNS_BUNDLE_ID`. Supply either `APNS_KEY_FILE` or `APNS_KEY_P8`. Never put the .p8
key in Git. Registration must specify the environment corresponding to the signed
app's push entitlement, not simply assume all debug builds use the same environment.

## Estimates

Off by default. Set `ENABLE_ESTIMATES=true` only for evaluation. UI must label values
**Est.**, not official Sleeper/Yahoo projections. Source: undocumented Sleeper weekly
projection feed plus undocumented ESPN game status; Sleeper players data maps bye
players to teams. Responses were checked on October 13, 2026, but may change.

For offensive players/kickers: actual team points plus each unfinished starter's
pregame projected points multiplied by remaining regulation game time. D/ST uses a
blend of its actual points and pregame projection to avoid double-counting starting
points-allowed credit. Explicit scoreboard byes have no remaining contribution.
Final teams use actual points. League scoring weights apply to supported stats.
Unknown scoring keys (including yardage bonus rules), missing data, suspended games,
or overtime produce `null`, never a fake zero or a partial team total.

This is a rough time-based estimate, not a calibrated prediction. Injuries, game
script, possession, delayed stats, current-team metadata for old weeks, sparse feed
stats and defensive scoring buckets limit accuracy. Projection feed revisions may
also change the baseline. Do not present it as injury-aware or promise Yahoo parity.
Real-game testing has been reported successful, but does not establish prediction
accuracy. Feed failure hides projections while actual scores keep updating.

## Reliability and limits

- Poll interval is 60–90 seconds (75 default), measured after each run finishes.
  Requests and Apple delivery add delay. Polling runs for active activities, even
  before kickoff; no active activities means no Sleeper polling.
- Scores push on change. Unchanged healthy data gets a heartbeat after 180 seconds;
  stale-date is the score fetch time + 360 seconds. Show stale state in the widget.
- Actual score changes (either team, including corrections) use priority 10.
  Unchanged-score heartbeats, projection-only changes, and initial sync with unchanged
  scores use priority 5; end pushes use 10. No alerts/sounds. Failed sends do not
  advance the accepted-score baseline. iOS delivery budgets still apply.
- APNs Unregistered ends that token's activity. Other failures back off up to 15
  minutes; inspect server logs for configuration failures. Rotation resets backoff.
- End locally in the app, then DELETE the registration. Server also expires it eight
  hours after its actual start. A Sunday activity must be restarted for Monday.
- No automatic game-final ending yet. Final scores may receive heartbeat pushes
  until expiry or the user ends the activity.
- Once sent, the network may still deliver a push after the user ends locally;
  the server prevents subsequent work for ended activities.
- At-least-once retry: a crash between Apple accepting a push and the database
  committing can cause a repeated update. Exactly-once delivery is not claimed.
- Polling is single-flight; identity checks/caps are transactional. Late responses
  from a superseded token cannot mark its replacement invalid.
- Automatic App Attest enrollment is implemented; legacy invite enrollment is disabled by default when App Attest
  is enabled. App Attest verifies app/device integrity, not ownership of a
  Sleeper username. Security hardening is still in progress.

## Storage and backups

SQLite stores device credential hashes and activity registrations. This design
supports a single server instance; separate instances with separate databases do
not share state. Keep the database and its backups private.

`npm run backup` creates a consistent online SQLite backup, defaulting to
`data/backups`. It is a manual command, not an automatic schedule. Keep recovery
copies separately and test restores with the server stopped.

## Source layout

- `server.js`: startup and shutdown; `config.js`: environment validation.
- `app.js`: authenticated HTTP API, request limits, and activity registration.
- `enrollment.js`: App Attest challenges and verification.
- `registrations.js`: transactional SQLite storage; `backup.js`: database backups.
- `sleeper.js`: upstream data and caching; `projections.js`: optional estimates.
- `poller.js`: polling, lifecycle, change detection, and retries.
- `apns.js`: signed Apple push requests.
- `test/`: automated regression tests; `scripts/benchmark.mjs`: synthetic load test.

## Request protection

Before parsing API bodies or reading credentials from SQLite, `/v1` requests pass
an in-memory fixed-window limit: 400 per IP and 1,200 total admissions per minute.
Rejected requests return HTTP 429 with `Retry-After` in seconds and `no-store`.
The ingress counters are separate from enrollment and authenticated-device limits;
the IP map is bounded by the total admission budget and resets each minute.
`/health` is outside this gate. Existing limits still apply after admission.

These limits include legitimate requests and can temporarily affect users sharing
an IP or the entire service during sustained abuse. They reset on process restart,
are per instance, and are not a distributed denial-of-service defense. IP identity
currently relies on Express's one-hop trusted-proxy setting; the actual proxy path
still needs verification. Rotating IPs (including IPv6 addresses) share the global
budget but are not grouped by subnet.

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

## Testing

Run `npm test` for the server regression suite. It covers authentication, activity
ownership and rotation, polling/retries, enrollment/replay, and compressed-body
rejection. General JSON bodies are limited to 8 KiB; enrollment bodies to 32 KiB.
Both parsers reject compressed request bodies. Mocked tests do not prove Apple
acceptance, device delivery timing, or immunity to all attacks.

Run `npm run test:load` for the synthetic twelve-user benchmark; results are written
to `load-test-results.json`. The measurements below are historical, not a fresh run
or a capacity guarantee for the current code.

Four separate Node processes were tested: idle, 12 users sharing a league, 12 users in separate leagues, and separate leagues with failures. Active scenarios each advanced a simulated clock through 360 polling cycles (7.5 hours at 75 seconds/cycle), with every user refreshing through the real authenticated HTTP API every cycle and every score changing. The real caching, matchup calculation, poller, ownership checks, and disk-backed SQLite transaction code ran. The HTTP load generator ran inside the measured process, so its overhead is included.

This is an accelerated workload, NOT a 7.5-hour wall-clock soak. Each active run finished in about 1.4–1.6 seconds; this does not measure real internet latency, a full game's memory behavior, or phone delivery. The idle baseline lasted 10 seconds and includes a frequent measurement timer.

### Historical measurements (October 21, 2026)

- Idle: mean resident memory 59.6 MiB, peak 59.7 MiB; 0.072 CPU seconds over 10 wall-clock seconds.
- Shared league: mean 160.5 MiB, peak 191.3 MiB; 1.134 CPU seconds for 360 cycles. 4,344 HTTP requests, no errors, 4,320 simulated push attempts, 635 simulated upstream fetches. Local HTTP p95 2.88 ms.
- Twelve leagues: mean 161.5 MiB, peak 188.9 MiB; 1.319 CPU seconds for 360 cycles. 4,344 HTTP requests, no errors, 4,320 simulated push attempts, 7,608 simulated upstream fetches. Local HTTP p95 3.32 ms.
- Outages: mean 161.9 MiB, peak 189.9 MiB. Five consecutive polling cycles failed upstream; exactly 60 foreground requests returned expected errors. Every tenth simulated push failed (426 failures). All 12 registrations remained active and resumed successful sends. No unexpected HTTP failures.
- Database plus SQLite WAL/SHM files: approximately 4.01 MiB at the end of each active run. This is an end-of-run footprint, not indefinite growth of 4 MiB per session. This test does not characterize long-term device-record retention or backups.

The 12-league scenario's modeled outbound bytes were 10.1 MB for the simulated 7.5 hours. This counts serialized push/API response bodies, synthetic upstream request sizes, and fixed header allowances. It is NOT packet-level network measurement; no TLS handshakes, compression, real header sizes, or retransmissions were captured. Extrapolation to 80 active hours/month is about 108 MB; 720 continuously active hours would be about 971 MB. Use a larger allowance in budgeting.

No real APNs keys, tokens, invitations, or production databases are read by the harness. Push delivery and Sleeper responses are mocked; projections are disabled. No phone notification is sent. Temporary databases are removed after each scenario.
