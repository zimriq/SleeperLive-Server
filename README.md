# SleeperLive server

The backend for [SleeperLive](https://github.com/zimriq/SleeperLive), an iPhone app for following Sleeper fantasy football matchups through Live Activities.

[Server test runs](https://github.com/zimriq/SleeperLive-Server/actions/workflows/server-tests.yml) · [Download the app](https://apps.apple.com/us/app/sleeperlive/id6826844567)

## What it does

- Fetches Sleeper matchup data and shares requests across users in the same league/week.
- Stores device credentials and activity registrations in SQLite.
- Sends score changes and freshness heartbeats through Apple Push Notification service (APNs).
- Supports App Attest enrollment, token rotation, retry backoff, manual-refresh recovery, and activity expiry.
- Provides optional experimental projections, device-data deletion, and manual database backups.

This is a small, single-instance service. It does not provide big-play alerts, avatars, or win probabilities.

## How it fits together

The iPhone app discovers a matchup, obtains a server snapshot, starts a Live Activity, and registers its activity push token. The server polls active matchups and submits updates to APNs. The app’s widget extension displays the content on the phone.

Apple accepting a push does not prove that iOS displayed it. Polling frequency and phone delivery frequency are different.

## Requirements

- Node.js **24 or later**, including built-in SQLite.
- npm and the committed lockfile.
- Persistent storage for the SQLite database when deployed.
- Apple developer credentials and a matching app bundle ID for live push delivery.

Dependencies include Express, cbor, and node-app-attest. No Apple credentials are required for the isolated automated tests.

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

## Essential configuration

Use `.env.example` as the configuration reference and `config.js` for validated defaults and bounds. Keep secrets and databases out of Git.

- `DB_PATH`: SQLite location; use persistent storage in deployment.
- `APNS_MODE`: `dry-run` by default; `live` submits real pushes.
- `APNS_BUNDLE_ID`, `APNS_TEAM_ID`, `APNS_KEY_ID`, and an APNs private key: required for live delivery.
- `APP_ATTEST_ENABLED` and the app identity settings: control automatic device enrollment.
- `INVITE_ENROLLMENT_ENABLED` and `INVITE_CODE`: control legacy private enrollment. It is disabled by default when App Attest is enabled.
- `POLL_SECONDS`: 75 by default, with a supported range of 60–90.
- `APNS_MAX_CONCURRENT_SENDS`: four workers by default, with a supported range of 1–16.
- `ENABLE_ESTIMATES`: optional experimental estimates, off by default.

See [API and enrollment](docs/API.md) for the client contract and [operations](docs/OPERATIONS.md) for storage and backup requirements.

## Run tests

```bash
npm ci
npm test
```

The regression suite checks enrollment and authentication, ownership, registration limits, SQLite persistence, token rotation, retries, concurrent push workers, upstream failures, deletion, and backups using isolated fixtures.

For the separate synthetic twelve-user benchmark:

```bash
npm run test:load
```

The benchmark writes `load-test-results.json`. It simulates upstream services and push delivery; it does not contact production. Historical measurements and methodology are in [Testing](docs/TESTING.md).

## GitHub Actions

The [Server tests workflow](.github/workflows/server-tests.yml) runs `npm ci` and `npm test` on Ubuntu with **Node.js 24**. The current local workflow runs on pushes to `main` and `develop`, pull requests targeting `main`, and manual dispatches.

View the tested commit and pass/fail result in [Actions](https://github.com/zimriq/SleeperLive-Server/actions/workflows/server-tests.yml). This workflow tests code; it does not deploy or send real Apple pushes. The companion app has its own Xcode simulator workflow.

## Reliability and practical limits

- Polling runs only for active registrations. The interval begins after the previous run finishes, so requests and processing add delay.
- Score changes and initial/recovery updates use urgent pushes. Unchanged-score heartbeats default to priority 5 and may be delayed by iOS.
- A stale date indicates data freshness; neither urgent priority nor a successful APNs response guarantees timely phone delivery.
- Invalidated tokens pause delivery until a replacement is registered. Activities expire eight hours after their original start.
- SQLite storage and the in-memory credential index assume one process owns database writes. Independent replicas do not share state.
- `/health` is a liveness endpoint, not proof that upstream feeds, polling, or push delivery are healthy.
- Projections are rough estimates based on external feeds, not official Sleeper live projections.

Read [Reliability](docs/RELIABILITY.md) for exact limits, request safeguards, caching, and retry behavior.

## Data and operations

The server stores credential hashes and registration data. Device-data deletion removes records from the logical active database; it does not erase old SQLite pages, logs, or backups. Revocation and deletion have different contracts.

`npm run backup` creates a checked SQLite copy. It is a manual command, not a backup schedule. Optional retention is disabled by default. Deployment needs persistent storage and a separately verified backup/restore procedure.

See [Operations](docs/OPERATIONS.md) before performing backups, restoration, revocation, or deletion.

## Documentation

- [API and app integration](docs/API.md): endpoints, payloads, App Attest enrollment, and token recovery.
- [Operations](docs/OPERATIONS.md): storage, backups, retention, revocation, and deletion.
- [Reliability](docs/RELIABILITY.md): polling, push delivery, estimates, safeguards, and limits.
- [Testing](docs/TESTING.md): automated checks, synthetic load scenarios, and historical measurements.
- [Development notes](docs/DEVELOPMENT-NOTES.md): dated delivery experiments; not production instructions.

## Source layout

- `server.js`: startup and shutdown; `config.js`: environment validation.
- `http-server.js`: HTTP header, upload, and keep-alive boundaries.
- `app.js`: authenticated HTTP API, request limits, and activity registration.
- `enrollment.js`: App Attest challenges and verification.
- `revoke-device.js`: shared revocation logic and offline operator command.
- `rate-limit.js`: bounded fixed-window counters for the existing API limits.
- `registrations.js`: transactional SQLite storage; `backup.js`: database backups.
- `sleeper.js`: upstream data and caching; `projections.js`: optional estimates.
- `poller.js`: polling, lifecycle, change detection, and retries.
- `apns.js`: signed Apple push requests.
- `test/`: automated regression tests; `scripts/benchmark.mjs`: synthetic load test.

## Validation status and follow-up work

Real-device and live-game behavior has been reported working, and automated tests cover many recovery paths. These are bounded checks, not proof that the service has no bugs or that a deployment matches the reviewed source.

The app’s handling of `needsPushToken` remains a priority integration follow-up: the server can request a replacement token while the app acknowledges the response as successful. See the [recovery contract](docs/API.md#recovery-contract-develop-november-6-2026).

Production backup policies, restoration/deletion reconciliation, and actual locked-phone delivery require operational verification. See the detailed documents for context rather than treating historical experiments as current deployment instructions.
