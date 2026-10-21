# SleeperLive server

Small, single-instance Node.js server for Sleeper fantasy matchup Live Activities.
It keeps device credentials and activities in SQLite, shares Sleeper requests across
users, and sends score changes and freshness heartbeats through APNs.

## Status

Implemented: authenticated private testing, durable registrations, token rotation,
75-second polling, score/name lookup, retry backoff, activity expiry, APNs payloads,
and an optional experimental live estimate. No big-play alerts, avatars, or win probability.

Tested locally with Node 26.8.1; deployment image uses Node 24. The project requires
Node 24+ for built-in SQLite. Express is the only installed dependency.
Real Apple delivery and Railway deployment have NOT been tested. The iOS app still
needs its widget extension, push capability, token registration, and matching models.
The existing app is not automatically connected to this server.

## Local setup

1. Run `npm ci` (or keep the existing installed Express dependency).
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

## Hosting on Railway

Use the included Dockerfile, one replica, and an always-running service. Attach a
persistent volume at `/data` and set `DB_PATH=/data/server.sqlite`. Set environment
variables in Railway, expose the HTTP port, and configure `/health` as the health
check. Do not enable service sleeping for this polling worker.

Budget goal: $5–10/month for roughly 12 users; not a quote. Track actual resource
usage and configure billing alerts. No Redis or separate database service is needed.
SQLite and the transactional document store deliberately target a small, single
instance. Don't scale to multiple replicas using separate local databases.

`npm run backup` makes a consistent online SQLite backup (defaults to data/backups).
This is manual, not an automatic schedule. Configure Railway volume backups and
keep a copy outside the volume for recovery from volume loss. Restore while the
service is stopped; test recovery before public release.

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
Compare it with real games before enabling for users. Live-game behavior has not
been verified. Feed failure hides projections while actual scores keep updating.

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
- Private invite onboarding only. Before public App Store launch, implement a
  public enrollment/abuse-control flow (e.g. App Attest), plus privacy/support pages.
  Sleeper username is not authentication.

See CONTRACT.md for iOS integration. The old unauthenticated `/register` and
`/unregister` routes were replaced intentionally. No migration is needed for the
original in-memory Map; it never survived a restart.
