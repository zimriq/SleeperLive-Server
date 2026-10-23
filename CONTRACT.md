# iOS contract v1

HTTPS on deployment. JSON uses camelCase. All dates are Int Unix seconds.
Store device credentials in Keychain; never put the APNs signing key in the app.
The app creates an ActivityKit Live Activity with pushType .token; no push-to-start.

## Enrollment (private test)

POST /v1/devices
Body: {"inviteCode":"the invite entered by the tester"}
Response 201: {"deviceId":"...", "deviceToken":"..."}

All following endpoints require Authorization: Bearer <deviceToken>.
A 401 means reenrollment is needed. A 429 is rate-limited; honor Retry-After.
Invite codes are for private tests only; public enrollment is not built.

## Initial and refreshed matchup

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

## Register and rotate

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

## Read or end

GET /v1/activities/<id> returns status, attributes, state, expiresAt, lastAcceptedAt.
State is the initial snapshot or latest successful APNs submission, not proof of
phone delivery. To get freshly fetched scores, use GET /v1/matchup.

End locally with ActivityKit, then DELETE /v1/activities/<id> (204, idempotent).
Retry deletion if offline; server expiry bounds abandoned registrations.
DELETE /v1/devices/me revokes this device and requests end pushes for its activities.

## Ordering and freshness

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

## Automatic enrollment (disabled by default)

See [ENROLLMENT.md](ENROLLMENT.md) for the App Attest challenge/completion contract,
client-generated credentials, retry behavior and staged rollout. Existing invite
registration and bearer-authenticated endpoints retain their current contract.
