create extension if not exists pg_trgm;

create table if not exists catalog_libraries (
  id text primary key references library_roots(id) on delete restrict,
  display_name text not null, updated_at timestamptz not null default now()
);
create table if not exists catalog_series (
  id bigserial primary key, library_id text not null references catalog_libraries(id) on delete restrict,
  identity_key text not null check (identity_key ~ '^[0-9a-f]{64}$'), identity_canonical_json jsonb not null, display_name text not null,
  search_key text not null, sort_key text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(library_id, identity_key)
);
create table if not exists catalog_publications (
  id bigserial primary key, series_id bigint not null references catalog_series(id) on delete restrict,
  identity_key text not null check (identity_key ~ '^[0-9a-f]{64}$'), publication_identity_canonical_json jsonb not null, kind text not null check(kind in ('artbook','special','chapter','issue','volume')),
  display_name text not null, search_key text not null, sort_key text not null, volume integer, number_text text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(series_id, identity_key)
);
create table if not exists catalog_releases (
  id bigserial primary key, publication_id bigint not null references catalog_publications(id) on delete restrict,
  source_item_id bigint not null unique references source_items(id) on delete restrict,
  root_id text not null references library_roots(id) on delete restrict,
  metadata_completeness integer not null default 0 check(metadata_completeness >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists catalog_entities (
  id bigserial primary key, kind text not null check(kind in ('creator','group','publisher')),
  identity_text text not null, search_key text not null, display_name text not null,
  unique(kind, identity_text)
);
create table if not exists catalog_credits (
  release_id bigint not null references catalog_releases(id) on delete restrict,
  entity_id bigint not null references catalog_entities(id) on delete restrict,
  role text not null check(role in ('writer','penciller','inker','colorist','letterer','cover_artist','editor','group','publisher','imprint')),
  primary key(release_id, entity_id, role)
);
create table if not exists catalog_preferred_release_overrides (
  root_id text not null references library_roots(id) on delete restrict,
  publication_identity_key text not null check(publication_identity_key ~ '^[0-9a-f]{64}$'),
  preferred_source_item_id bigint not null references source_items(id) on delete restrict,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(root_id, publication_identity_key)
);

-- This is a rebuildable read model. Zero counts are retained so a temporarily hidden or
-- unavailable source does not erase catalog identity; API list reads require count > 0.
create table if not exists catalog_series_list_state (
  series_id bigint primary key references catalog_series(id) on delete restrict,
  library_id text not null references catalog_libraries(id) on delete restrict,
  display_name text not null, sort_key text not null,
  search_document text not null,
  visible_publication_count integer not null check (visible_publication_count >= 0),
  source_updated_mtime_ms bigint not null,
  discovered_at timestamptz not null,
  metadata_updated_at timestamptz not null,
  refreshed_at timestamptz not null default now()
);
create index if not exists catalog_series_name_key_idx on catalog_series(library_id, sort_key collate "C", id);
create index if not exists catalog_series_cross_library_name_key_idx on catalog_series(sort_key collate "C", id);
create index if not exists catalog_publications_name_key_idx on catalog_publications(series_id, sort_key collate "C", id);
create index if not exists catalog_series_search_trgm_idx on catalog_series using gin(search_key gin_trgm_ops);
create index if not exists catalog_publications_search_trgm_idx on catalog_publications using gin(search_key gin_trgm_ops);
create index if not exists catalog_releases_publication_idx on catalog_releases(publication_id, source_item_id);
create index if not exists catalog_credits_entity_idx on catalog_credits(entity_id, release_id);
create index if not exists catalog_releases_source_item_idx on catalog_releases(source_item_id, publication_id);
create index if not exists catalog_series_list_state_name_idx on catalog_series_list_state(sort_key collate "C", series_id) where visible_publication_count > 0;
create index if not exists catalog_series_list_state_library_name_idx on catalog_series_list_state(library_id, sort_key collate "C", series_id) where visible_publication_count > 0;
-- Every keyset is (sort key, series id) in one direction.  An ascending B-tree can be
-- scanned backwards, while mixed directions cannot, so keep both columns ascending.
create index if not exists catalog_series_list_state_source_updated_idx on catalog_series_list_state(source_updated_mtime_ms, series_id) where visible_publication_count > 0;
create index if not exists catalog_series_list_state_library_source_updated_idx on catalog_series_list_state(library_id, source_updated_mtime_ms, series_id) where visible_publication_count > 0;
create index if not exists catalog_series_list_state_discovered_idx on catalog_series_list_state(discovered_at, series_id) where visible_publication_count > 0;
create index if not exists catalog_series_list_state_library_discovered_idx on catalog_series_list_state(library_id, discovered_at, series_id) where visible_publication_count > 0;
create index if not exists catalog_series_list_state_metadata_updated_idx on catalog_series_list_state(metadata_updated_at, series_id) where visible_publication_count > 0;
create index if not exists catalog_series_list_state_library_metadata_updated_idx on catalog_series_list_state(library_id, metadata_updated_at, series_id) where visible_publication_count > 0;
create index if not exists catalog_series_list_state_search_trgm_idx on catalog_series_list_state using gin((search_document collate "C") gin_trgm_ops);

-- A configured root can be unavailable without hiding its last successful projection. Only an
-- explicitly inactive root is filtered. A completed current generation with no valid pages is
-- hidden, while pending validation remains visible.
create or replace view visible_source_items as
  select i.* from source_items i join library_roots r on r.id=i.root_id
  where i.active and r.active and i.quarantine_reason is null
    and not exists (select 1 from global_source_suppressions s where s.source_item_id=i.id)
    and not exists (
      select 1 from page_validation_runs v
      where v.source_item_id=i.id and v.manifest_sha256=i.manifest_sha256
        and v.generation=i.validation_generation and v.state='completed' and v.valid_count=0
    );

insert into gutter_schema (version) values ('0006_catalog_domain') on conflict (version) do nothing;
