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
  const attestEnabled = flag('APP_ATTEST_ENABLED');
  const inviteEnabled = env.INVITE_ENROLLMENT_ENABLED === undefined ? !attestEnabled : flag('INVITE_ENROLLMENT_ENABLED');
  if (inviteEnabled && (env.INVITE_CODE ?? '').length < 24) throw new Error('Set INVITE_CODE to a random secret of at least 24 characters');
  const c = {
    port: number('PORT', 3000, 1, 65535), db: env.DB_PATH ?? './data/server.sqlite',
    attestEnabled, inviteEnabled,
    attestAllowDevelopment: flag('APP_ATTEST_ALLOW_DEVELOPMENT'),
    attestAppIdPrefix: env.APP_ATTEST_APP_ID_PREFIX,
    invite: env.INVITE_CODE, mode, projections: env.ENABLE_ESTIMATES === 'true',
    pushConcurrency: number('APNS_MAX_CONCURRENT_SENDS', 4, 1, 16),
    pollMs: number('POLL_SECONDS', 75, 60, 90) * 1000,
    maxDevices: number('MAX_DEVICES', 50, 1, 1000), maxActivities: number('MAX_ACTIVITIES', 100, 1, 1000),
    ingressPerIP: number('API_REQUESTS_PER_IP_PER_MINUTE', 400, 1, 10000),
    ingressGlobal: number('API_REQUESTS_PER_MINUTE', 1200, 1, 10000),
    perDevice: number('MAX_ACTIVITIES_PER_DEVICE', 3, 1, 10),
    bundleId: env.APNS_BUNDLE_ID, teamId: env.APNS_TEAM_ID, keyId: env.APNS_KEY_ID,
    productionKeyId: env.APNS_PRODUCTION_KEY_ID,
    productionKey: env.APNS_PRODUCTION_KEY_FILE ? readFileSync(env.APNS_PRODUCTION_KEY_FILE, 'utf8') : env.APNS_PRODUCTION_KEY_P8?.replaceAll('\\n', '\n'),
    key: env.APNS_KEY_FILE ? readFileSync(env.APNS_KEY_FILE, 'utf8') : env.APNS_KEY_P8?.replaceAll('\\n', '\n'),
  };
  if (c.ingressPerIP > c.ingressGlobal) throw new Error('API_REQUESTS_PER_IP_PER_MINUTE must not exceed API_REQUESTS_PER_MINUTE');
  if (Boolean(c.productionKeyId) !== Boolean(c.productionKey)) throw new Error('Set both APNS_PRODUCTION_KEY_ID and APNS_PRODUCTION_KEY_P8 (or FILE)');
  if (mode === 'live' && (!c.bundleId || !c.teamId || !c.keyId || !c.key)) throw new Error('Missing APNs credentials');
  if (c.attestEnabled && (!/^[A-Z0-9]{10}$/.test(c.attestAppIdPrefix ?? '') || !c.bundleId)) throw new Error('Set APP_ATTEST_APP_ID_PREFIX and APNS_BUNDLE_ID');
  return c;
}
