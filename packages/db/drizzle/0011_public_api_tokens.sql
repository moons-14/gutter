-- Public API PATs are scoped, revocable, and never store bearer material.
create table gutter_public_api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user"(id) on delete cascade,
  token_hash bytea not null unique,
  label text not null check (char_length(label) between 1 and 128),
  scopes text[] not null default array[
    'catalog:read','search:read','page:read','reading-state:read','reading-state:write',
    'collections:read','collections:write'
  ]::text[] check (scopes <@ array[
    'catalog:read','search:read','page:read','reading-state:read','reading-state:write',
    'collections:read','collections:write'
  ]::text[]),
  expires_at timestamptz,
  created_at timestamptz not null default now(), last_used_at timestamptz, revoked_at timestamptz
);
create index gutter_public_api_tokens_user_idx on gutter_public_api_tokens(user_id) where revoked_at is null;
insert into gutter_schema (version) values ('0011_public_api_tokens') on conflict (version) do nothing;
grant select, insert, update on gutter_public_api_tokens to gutter_api;
