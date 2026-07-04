import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.js';

// A minimal set of the REQUIRED env vars so loadEnv() parses. Boolean flags are
// added per-test on top of this base.
const BASE: NodeJS.ProcessEnv = {
  PUBLIC_BASE_URL: 'https://grace-api.fly.dev',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  TWILIO_ACCOUNT_SID: 'AC_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  GEMINI_API_KEY: 'key_test',
};

describe('env boolean flags — "false" must mean OFF (z.coerce.boolean footgun)', () => {
  it('UNIFIED_REPLY_PATH=false is OFF, not ON (the production bug)', () => {
    // z.coerce.boolean() did Boolean("false") === true, silently pinning the
    // flag ON even after `fly secrets set UNIFIED_REPLY_PATH=false`. Guard it.
    expect(loadEnv({ ...BASE, UNIFIED_REPLY_PATH: 'false' }).UNIFIED_REPLY_PATH).toBe(false);
    expect(loadEnv({ ...BASE, UNIFIED_REPLY_PATH: '0' }).UNIFIED_REPLY_PATH).toBe(false);
    expect(loadEnv({ ...BASE, UNIFIED_REPLY_PATH: 'off' }).UNIFIED_REPLY_PATH).toBe(false);
    expect(loadEnv({ ...BASE, UNIFIED_REPLY_PATH: 'no' }).UNIFIED_REPLY_PATH).toBe(false);
    expect(loadEnv({ ...BASE, UNIFIED_REPLY_PATH: '' }).UNIFIED_REPLY_PATH).toBe(false);
  });

  it('affirmative tokens turn a flag ON', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', 'On']) {
      expect(loadEnv({ ...BASE, UNIFIED_REPLY_PATH: v }).UNIFIED_REPLY_PATH).toBe(true);
    }
  });

  it('honors each flag default when the var is absent', () => {
    const env = loadEnv({ ...BASE });
    expect(env.UNIFIED_REPLY_PATH).toBe(false); // default off
    expect(env.COMPACT_REPLY_MODE).toBe(false);
    expect(env.DIRECT_REPLY_MODE).toBe(false);
    expect(env.GEMINI_FIRST).toBe(true); // default on
    expect(env.RELEVANCE_CHECK_ENABLED).toBe(true);
  });

  it('a default-ON flag can be turned OFF with "false"', () => {
    expect(loadEnv({ ...BASE, GEMINI_FIRST: 'false' }).GEMINI_FIRST).toBe(false);
    expect(loadEnv({ ...BASE, RELEVANCE_CHECK_ENABLED: 'false' }).RELEVANCE_CHECK_ENABLED).toBe(false);
  });
});
