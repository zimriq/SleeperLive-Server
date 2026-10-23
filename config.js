import { readFileSync } from 'node:fs';
export function config(env = process.env) {
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const flag = key => {
    if (env[key] !== undefined && !['true', 'false'].includes(env[key])) throw new Error(`Invalid ${key}`);
    return env[key] === 'true';
  };
  const mode = env.APNS_MODE ?? 'dry-run';
  if (!['dry-run', 'live'].includes(mode)) throw new Error('Invalid APNS_MODE');
  if ((env.INVITE_CODE ?? '').length < 24) throw new Error('Set INVITE_CODE to a random secret of at least 24 characters');
  const c = {
    port: number('PORT', 3000, 1, 65535), db: env.DB_PATH ?? './data/server.sqlite',
    attestEnabled: flag('APP_ATTEST_ENABLED'),
    attestAllowDevelopment: flag('APP_ATTEST_ALLOW_DEVELOPMENT'),
    attestAppIdPrefix: env.APP_ATTEST_APP_ID_PREFIX,
    invite: env.INVITE_CODE, mode, projections: env.ENABLE_ESTIMATES === 'true',
    pollMs: number('POLL_SECONDS', 75, 60, 90) * 1000,
    maxDevices: number('MAX_DEVICES', 50, 1, 1000), maxActivities: number('MAX_ACTIVITIES', 100, 1, 1000),
    perDevice: number('MAX_ACTIVITIES_PER_DEVICE', 3, 1, 10),
    bundleId: env.APNS_BUNDLE_ID, teamId: env.APNS_TEAM_ID, keyId: env.APNS_KEY_ID,
    key: env.APNS_KEY_FILE ? readFileSync(env.APNS_KEY_FILE, 'utf8') : env.APNS_KEY_P8?.replaceAll('\\n', '\n'),
  };
  if (mode === 'live' && (!c.bundleId || !c.teamId || !c.keyId || !c.key)) throw new Error('Missing APNs credentials');
  if (c.attestEnabled && (!/^[A-Z0-9]{10}$/.test(c.attestAppIdPrefix ?? '') || !c.bundleId)) throw new Error('Set APP_ATTEST_APP_ID_PREFIX and APNS_BUNDLE_ID');
  return c;
}
