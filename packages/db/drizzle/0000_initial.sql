create table if not exists gutter_schema (
  version text primary key,
  applied_at timestamptz not null default now()
);
insert into gutter_schema (version) values ('0000_initial') on conflict (version) do nothing;
