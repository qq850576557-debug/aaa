import { z } from 'zod';
export const config = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']),
    DATABASE_URL: z.string().url(),
    PRIVATE_DATABASE_URL: z.string().url(),
    PRIVATE_DATA_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
    APP_ORIGIN: z.string().url(),
    API_PORT: z.coerce.number().int().min(1024).max(65535).default(4000),
  })
  .parse(process.env);
const origin = new URL(config.APP_ORIGIN);
if (config.APP_ENV === 'production' && origin.protocol !== 'https:')
  throw Error('Production requires HTTPS');
if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
  throw Error('HTTP is restricted to explicit local development');
if (config.APP_ENV === 'test') {
  for (const address of [
    config.DATABASE_URL,
    config.PRIVATE_DATABASE_URL,
    process.env.MIGRATION_DATABASE_URL,
  ].filter(Boolean)) {
    const u = new URL(address!);
    if (!u.pathname.endsWith('_test') || !['127.0.0.1', 'localhost'].includes(u.hostname))
      throw Error('Tests require dedicated local _test databases for every connection');
  }
}
