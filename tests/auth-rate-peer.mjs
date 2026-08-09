import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.AUTH_BASE_URL;
const origin = process.env.AUTH_PUBLIC_ORIGIN;
const label = process.env.AUTH_PEER_LABEL;
if (!base || !origin || !label) throw new Error('auth rate peer requires base, origin, and label');

const responses = await Promise.all(
  Array.from({ length: 6 }, (_, index) =>
    fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        host: new URL(origin).host,
        origin,
        'content-type': 'application/json',
        'x-forwarded-for': `198.51.100.${label === 'a' ? index + 1 : index + 101}`,
      },
      body: JSON.stringify({
        email: `rate-peer-${label}@example.invalid`,
        password: 'wrong-password-value',
      }),
    }),
  ),
);

assert.equal(
  responses.some((response) => response.status === 429),
  false,
  `direct ingress peer ${label} has an independent rate-limit bucket`,
);

// Keep both fixed-IP peers alive long enough for their requests to overlap.
await delay(1_000);
