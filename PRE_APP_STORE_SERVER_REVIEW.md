# Server change ledger and pre-App-Store review

Recorded November 3, 2026. Keep this file on **develop**. This is the handoff for the production/Railway review after app features are complete. Local implementation and tests do not establish deployed behavior. Do not record private keys, bearer credentials, database contents, or raw user logs here.

## Ongoing record

For every future server change, add its purpose, affected files, tests, configuration/deployment requirements, and external checks here. After committing, add the commit reference when practical. Keep work on develop; merging to main and deploying production require the owner's instruction. For each production verification, record date, deployed revision, sanitized evidence, and outcome. Until then, mark it unverified.

## Changes from this app-readiness work

- **4a2ea2d — authenticated device-data deletion.** app.js adds DELETE /v1/devices/me/data, removes the current device and all owned activity records transactionally, and prevents a late registration from recreating them. Other devices remain intact. Existing DELETE /v1/devices/me is still revocation. Server suite passed 79 tests at implementation; matching app suite passed 21. Deploy the server endpoint before using the new app action. Production deployment and device verification: **unverified**. Historical SQLite pages, logs and backups are not purged by this endpoint. A lost success response followed by 401 remains ambiguous in the app and needs support verification, not a false success claim.
- **55f6ac1 — optional backup retention and integrity checks.** backup.js verifies the new copy before publishing it without overwriting an existing filename. BACKUP_RETENTION_DAYS enables cleanup only when explicitly set to an integer 1–365. Unset means no cleanup. Eligible files must have generated UTC names and old modification times; symlinks, directories, custom copies and the live database are preserved. Failed backup creation does not prune. Six focused tests passed. No production backup or setting was touched. Schedule, selected retention period, Railway volume backups and restore reconciliation: **unverified**. Missed runs mean the configured age is not a wall-clock deletion deadline.
- **This documentation checkpoint.** Records earlier server changes and production checks below. It changes no runtime behavior or deployment settings.

## Earlier server history to recheck

These entries are from local Git history, not a claim that every change is deployed or has been independently retested in this review:

- 2b9a57f — stop retrying expired Live Activity push tokens.
- 0ba8d0e — restrict permissions for new server and backup files.
- f7e58e2 — prevent over-limit devices from exhausting shared allowances.
- 4cb23b9 — minimize retained credentials for revoked devices.
- 40cfecf — bound incoming HTTP headers and upload duration.
- ae6be3a — offline operator device revocation.
- aa174f3 — reserve authenticated access during anonymous request floods.
- 34692ff — explicit client-IP trust and Railway edge-header validation.
- e45a35e — reserve rate-limit capacity for authenticated devices.
- e67d4a4 — bound upstream JSON responses and cancel rejected bodies.
- 8f5b795 — bounded concurrent delivery to isolate slow pushes.
- 4513a30 — avoid full counter scans in the rate limiter.
- 2f0dfd1 — validated configurable API admission limits.
- d8bb5ac — remove internal details from public health responses.
- 2ff35b9 — back off failed projection feeds and deduplicate retries.
- 908d4d0 — disable invite enrollment by default with App Attest.
- 7da596b — limit requests before authentication and consolidate documentation.
- e4baf41 — reject compressed requests and update vulnerable dependencies.
- 1959c08 — TestFlight push keys and enrollment recovery.
- 7222ef1 — protected automatic device enrollment.
- ea1ca29 — initial polling, score-change pushes, and load tests.

## Railway and external verification before release

All items start **unverified**. Perform checks with a disposable registration where mutation is needed.

1. **Deployed revision and branch.** Record which branch Railway deploys and the exact revision running. Confirm deletion and backup features are included. Pushing develop alone does not prove a production deployment. Keep a rollback plan; an older server may not support the latest app endpoint.
2. **Persistent database.** Confirm DB_PATH points to the mounted persistent volume, survives restart/redeploy, and has appropriate access permissions. The store/credential index assumes one server instance; verify replica count and no other process writes the database. Never use the offline revocation tool while the server is running.
3. **Device verification.** Confirm APP_ATTEST_ENABLED and the correct app identifier prefix/bundle identifier. Check production/development acceptance settings for intended builds. Confirm the app registers without user-entered URLs/invites; disable public invitation enrollment when using production attestation. Do not expose invitation or Apple signing secrets in documentation or logs.
4. **Production push delivery.** Confirm APNS_MODE=live, matching bundle/team identity, appropriate Apple signing key environment and paired production-key configuration if used. Test a signed physical iPhone/TestFlight build, foreground/background/locked states, token rotation, expiration, stopping and deletion. Apple acceptance is not proof that the phone displayed the update.
5. **IP trust and rate limits.** Verify the deployed CLIENT_IP_MODE against the actual Railway HTTP edge path. railway-public requires the listener to be reachable through that trusted edge, without a bypass accepting forged headers. Verify spoofing resistance, independent anonymous/authenticated admission budgets, configured per-IP/global caps, Retry-After and proxy behavior in production. Local tests do not prove edge behavior.
6. **Resources and hosting limits.** Check device/activity caps, push concurrency, polling interval, upstream timeout/body limits, real game-day traffic, memory/CPU/network/storage growth, restart behavior, platform timeouts and spending alerts. Historical load tests do not guarantee present hosting cost or capacity.
7. **Backups.** Identify manual SQLite copies, Railway volume backups and off-site copies separately. Verify an actual schedule exists, where the job runs, access permissions, retention values, cleanup outcomes, recovery location, and restore testing. BACKUP_RETENTION_DAYS only affects this tool's directory when that command runs; it does not manage Railway's own backups.
8. **Deletion and restoration.** Verify owned device/activity records are removed and other devices remain intact; test an in-flight registration and credential invalidation. Define how support resolves an unconfirmed deletion. Document how deleted records are prevented from becoming live again after restoring an older backup. Finalize retention for old SQLite/WAL pages, replay records from revocation, caches and backups; do not describe revocation as erasure.
9. **Logs and diagnostics.** Inspect Railway access/application logging settings, retention and access controls without copying sensitive log contents into chat. Verify no bearer tokens, Apple keys, full attestation proofs or user payloads are logged. Determine whether retained IP/request/diagnostic data changes the privacy disclosures.
10. **Public availability.** Confirm HTTPS/certificate behavior, public health response, API error messages, upstream Sleeper availability and outage behavior. Review any infrastructure change that adds a proxy, analytics, monitoring service or subprocessor.
11. **Privacy and support.** Confirm operator identity/contact, support-mail retention, all processors, data uses and deletion-request handling. Update the privacy manifest and App Store answers if verified behavior differs. Publish the complete policy and connect it in the app and App Store Connect only after unresolved operational facts are settled.

## Release sign-off record

- Railway deployed revision: pending
- Deletion endpoint verified on production: pending
- Backup types, schedule and retention verified: pending
- Hosting log retention and redaction verified: pending
- Restore/deletion reconciliation verified: pending
- Signed-device push delivery verified: pending
- Privacy policy and App Store disclosures reconciled: pending
- Owner authorizes production release: pending

## Development environment observations — November 3, 2026

The user confirmed the develop deployment revision. The public endpoint https://sleeperlive-server-develop.up.railway.app/health was independently checked and returned ok=true/mode=dry-run. User-provided SSH output confirms environment develop and DB_PATH=/data/server.sqlite. Screenshots show /data mounts in both environments, but no unique volume IDs were captured; matching display names are not evidence of shared storage. A marker in /data survived a service restart (user-reported output). This verifies the marker, not yet device-record persistence.

The initial manual backup was written outside the volume at /app/data/backups. The user then set BACKUP_DIR=/data/backups on development only and supplied a successful backup result there, with retention disabled. The backup command performs its integrity check before reporting success. Scheduled backups, retention, restoration and log settings remain unverified.

An isolated SleeperLive Dev app build has been prepared for registration/deletion tests. Its app identifier is com.zimri.SleeperLive.Develop; the development Railway service must use that APNS_BUNDLE_ID for App Attest verification. That variable change has not been performed or verified by the agent. Keep APNS_MODE=dry-run initially and leave production unchanged. Remote Live Activity start is intentionally blocked in dry-run; real push and owned activity-record deletion still require a later controlled test. No production deployment, database mutation, or pull request merge has been performed as part of this preparation.

## Physical-device registration/deletion cycle — November 3, 2026

Environment: develop, dry-run. Evidence below is user-reported from the Dev app and read-only SSH count queries, not direct agent access to the deployed database.

- The physical iPhone's SleeperLive Dev app showed Device registration saved. The development database reported one active device.
- Delete device data reported success. The subsequent read-only query reported active devices=0, total device records=0, activity records=0. This confirms logical removal of the device record in that test environment, rather than only a revocation flag.
- After fully closing/reopening the Dev app without opting in again, background updates remained off and the count check remained at zero (user confirmed).
- Explicitly enabling background updates again produced active devices=1, total device records=1, activity records=0. Fresh enrollment after deletion therefore passed.

No actual server activity records were present during this cycle, so deployed owned-activity deletion, multi-device isolation, in-flight request races, and real APNs delivery are not established by these results. Existing local automated tests cover some of those cases, but live verification is separate. Persistence of an actual registered device across a service restart remains to be checked; the earlier restart used only a marker file. The exact deployed revision still needs to be recorded, even though the user confirmed the intended develop revision. No production checks or merge are implied.

## Registered-device persistence and authenticated matchup loading — November 3, 2026

The user restarted the develop service after creating the fresh device registration. A subsequent read-only SSH query reported active devices=1, total device records=1, activity records=0. The user then loaded a matchup successfully in SleeperLive Dev following the instructed post-restart matchup/refresh check. This establishes, from user-reported live-environment results, that an actual device registration survives service restart and its saved credentials remain usable for matchup access.

Development dry-run checks now passed: public health, /data marker persistence, manual backup creation/integrity at /data/backups with retention off, physical-device enrollment, logical device deletion, opt-out across app relaunch, fresh re-enrollment, actual device-record persistence, and post-restart authenticated matchup access. Actual APNs delivery, nonempty activity-record deletion, multi-device isolation, live race scenarios, scheduled backup/restore behavior, retention and log settings remain unverified. The local develop HEAD at documentation time is 8641c724cb983ff3cf3135ef73c858a20d410c51; this is not independently verified as the deployed revision. No production deployment or merge was performed.

## Pre-PR review and privacy facts — November 3, 2026

- Source reviewed at develop 952a2add2fcf2098a92b169c1b3761f759efca61; fetched origin/develop matches. Compared against origin/main 52e056ad87572355e06dcf1ac8672d4e92226394. No unpushed commits were present at that point.
- All 85 server tests passed in a fresh local review copy on both Node 26 and Node 24. A GitHub workflow was added to run the suite on Node 24, matching the Docker runtime major version. The workflow uses read-only contents permission, no production secrets, and no deployment step. GitHub execution must still be observed after pushing.
- Owner reports production Railway volume Backups tab is empty: no Railway volume snapshots currently exist. This does not establish whether separate manual SQLite copies exist. Create a production snapshot and enable/verify a backup schedule before merging/deploying. The earlier successful manual backup was development-only.
- Owner reports Trial plan with intention to move to Hobby, and Railway built-in logging only. Railway docs currently list a seven-day log visibility window for both; they also say plan upgrades can restore older logs, so this is not a permanent-erasure guarantee. No external monitoring/log forwarding is reported.
- Owner confirms operator identity Zimri Quinonez. Support contact is zimryquinonez@gmail.com. There is no automatic support-email deletion schedule; do not publish an invented retention deadline. The policy should explain actual manual retention and the privacy-request contact.
- Production retention configuration, first snapshot/schedule, restore reconciliation, real APNs delivery and distribution signing remain open. No production change, PR merge, or policy publication was performed.

References checked: https://docs.railway.com/volumes/backups and https://docs.railway.com/observability/logs . Railway currently documents daily/weekly/monthly snapshots with retention of 6/27/89 days respectively. Record the schedule actually selected and first successful snapshot instead of treating a recommendation as configuration evidence.
