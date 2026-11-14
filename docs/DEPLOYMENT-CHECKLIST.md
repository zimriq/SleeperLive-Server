# Deployment checklist

[Back to README](../README.md) · [Server operations](OPERATIONS.md) · [Testing](TESTING.md)

## Before deployment

- [ ] Confirm which Git branch each Railway environment deploys. Record the
  revision to deploy and the revision to restore if the rollout fails. Check
  that the rollback revision supports the app version in use.
- [ ] Set `DB_PATH` to the mounted volume and confirm one server instance owns
  database writes. Check volume permissions, database persistence across a
  redeploy, and the configured deployment drain time.
- [ ] Set the Railway health check path to `/health`. Confirm the public HTTP
  edge is the only API ingress before using `CLIENT_IP_MODE=railway-public`
  and `REQUIRE_PROXY_HTTPS=true`.
- [ ] Check App Attest and APNs settings against the intended signed build.
  Disable invitation enrollment for public releases that use App Attest.
- [ ] Review device and activity limits, push concurrency, and Railway resource
  usage against observed traffic. Run the load benchmarks before raising caps.
- [ ] Record where recovery copies are stored, their schedule and retention,
  and the most recent restore test. Verify how deletion requests are reconciled
  before a restored database serves traffic.

## Verify on develop

- [ ] Confirm the deployed revision, the Railway health check, and the public
  HTTPS response. Check HSTS when enforcement is enabled.
- [ ] On a signed iPhone, verify enrollment, matchup loading, and Live Activity
  delivery in the foreground, background, and on the lock screen. Test token
  replacement, expiry, and stopping an activity.
- [ ] With a disposable registration, verify data deletion and rejection of
  the old credential. Verify Reconnect after reaping a test registration and
  collect a week of candidate counts before enabling inactivity expiry in production.
- [ ] Observe automatic activity ending through a real game window on develop
  before enabling it in production.
- [ ] Verify the public edge supplies the expected client IP and HTTPS headers.
  Check admission limits and `Retry-After` during development testing.

## Release and follow-up

- [ ] Review hosting logs, access and retention. Keep credentials, attestation
  proofs, push tokens, and request bodies out of diagnostic output.
- [ ] Verify the public support contact and reconcile the privacy policy and
  App Store disclosures with the deployed service and retention practices.
- [ ] After deployment, confirm the revision, health, matchup loading, and
  delivery on a signed device. Review Railway logs and resource usage during
  the first game window.
