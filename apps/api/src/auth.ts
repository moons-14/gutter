import { authConfig } from '@gutter/config';
import { pool } from '@gutter/db';
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins/admin';
import { twoFactor } from 'better-auth/plugins/two-factor';

const config = await authConfig();

/**
 * Public signup is blocked by the Hono boundary. The only route which reaches this hook with
 * this header is the one-time, atomically claimed bootstrap endpoint below.
 */
const auth = betterAuth({
  appName: 'gutter',
  baseURL: config.origin,
  basePath: '/api/auth',
  secret: config.secret,
  database: pool,
  trustedOrigins: [config.origin],
  emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 10,
    customRules: { '/sign-in/email': { window: 900, max: 10 } },
  },
  advanced: {
    // HTTP is allowed only for browser-local bootstrap; every LAN/reverse-proxy origin is HTTPS.
    useSecureCookies: config.secureCookies,
    ipAddress: {
      ipAddressHeaders: ['x-forwarded-for'],
      trustedProxies: [...config.trustedProxies],
    },
  },
  plugins: [
    admin(),
    twoFactor({
      issuer: 'gutter',
      accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 900 },
    }),
    passkey({ rpID: new URL(config.origin).hostname, rpName: 'gutter', origin: config.origin }),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => {
          if (context?.request?.headers.get('x-gutter-bootstrap') === '1')
            return { data: { ...user, role: 'admin' } };
          // The admin plugin has already authenticated and authorized this exact endpoint.
          // All other creation paths remain blocked in addition to the Hono signup boundary.
          if (
            context?.request &&
            new URL(context.request.url).pathname === '/api/auth/admin/create-user'
          )
            return { data: user };
          return false;
        },
      },
    },
  },
});

export async function authHandler(request: Request): Promise<Response> {
  return auth.handler(request);
}

export async function authenticatedUser(
  request: Request,
): Promise<Readonly<{ id: string; role: string | null }> | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  return { id: session.user.id, role: session.user.role ?? null };
}

export function trustedMutationOrigin(request: Request): boolean {
  return request.headers.get('origin') === config.origin;
}
