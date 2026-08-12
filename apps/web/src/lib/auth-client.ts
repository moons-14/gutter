import { createAuthClient } from 'better-auth/client';
import { twoFactorClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';

// Tests replace this module with a deterministic client double.

/** Browser-only Better Auth client; the server remains the authorization boundary. */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [twoFactorClient(), passkeyClient()],
});
