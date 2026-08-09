-- Better Auth 1.6.26 schema. These tables hold credentials, sessions, TOTP recovery material,
-- and WebAuthn public keys; include all of them in an encrypted PostgreSQL backup and restore
-- them atomically with the application secret(s).
create table "user" (
  id text primary key, name text not null, email text not null unique, "emailVerified" boolean not null default false,
  image text, "createdAt" timestamptz not null, "updatedAt" timestamptz not null,
  role text, banned boolean default false, "banReason" text, "banExpires" timestamptz, "twoFactorEnabled" boolean default false
);
create table "session" (
  id text primary key, "expiresAt" timestamptz not null, token text not null unique, "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user"(id) on delete cascade,
  "impersonatedBy" text
);
create index session_user_id_idx on "session" ("userId");
create table account (
  id text primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user"(id) on delete cascade,
  "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  scope text, password text, "createdAt" timestamptz not null, "updatedAt" timestamptz not null
);
create index account_user_id_idx on account ("userId");
create table verification (
  id text primary key, identifier text not null, value text not null, "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null, "updatedAt" timestamptz not null
);
create index verification_identifier_idx on verification (identifier);
create table "twoFactor" (
  id text primary key, secret text not null, "backupCodes" text not null, "userId" text not null references "user"(id),
  verified boolean default true, "failedVerificationCount" integer default 0, "lockedUntil" timestamptz
);
create unique index two_factor_user_id_idx on "twoFactor" ("userId");
create index two_factor_secret_idx on "twoFactor" (secret);
create table passkey (
  id text primary key, name text, "publicKey" text not null, "userId" text not null references "user"(id),
  "credentialID" text not null, counter integer not null, "deviceType" text not null, "backedUp" boolean not null,
  transports text, "createdAt" timestamptz, aaguid text
);
create index passkey_user_id_idx on passkey ("userId");
create unique index passkey_credential_id_idx on passkey ("credentialID");
create table gutter_auth_bootstrap (id boolean primary key default true check (id), claimed_at timestamptz);
insert into gutter_auth_bootstrap (id) values (true);
insert into gutter_schema (version) values ('0008_auth_foundation') on conflict (version) do nothing;
