create type user_target_kind as enum ('check','series','publication','source');

create table gutter_user_state_revisions (
  user_id text primary key references "user"(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
create table user_progress (
  user_id text not null references "user"(id) on delete cascade,
  root_id text not null references library_roots(id) on delete restrict,
  source_key varchar(4096) not null check (source_key <> '' and source_key !~ E'\\x00' and source_key !~ '(^/|//|(^|/)\\.\\.?(/|$))'),
  page_ordinal integer not null check (page_ordinal between 0 and 1000000), completed boolean not null,
  revision bigint not null check (revision >= 1), first_read_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(), open_count bigint not null default 1 check (open_count >= 1),
  updated_at timestamptz not null default now(), primary key(user_id,root_id,source_key)
);
create table user_target_state (
  user_id text not null references "user"(id) on delete cascade, root_id text not null references library_roots(id) on delete restrict,
  target_kind user_target_kind not null, target_key varchar(4096) not null,
  favorite boolean not null default false, rating smallint check (rating between 1 and 5), note text check (char_length(note) <= 10000), hidden boolean not null default false,
  updated_at timestamptz not null default now(), primary key(user_id,root_id,target_kind,target_key),
  check ((target_kind = 'series' and target_key ~ '^[0-9a-f]{64}$') or (target_kind = 'publication' and target_key ~ '^[0-9a-f]{64}:[0-9a-f]{64}$') or (target_kind in ('check','source') and target_key <> '' and target_key !~ E'\\x00' and target_key !~ '(^/|//|(^|/)\\.\\.?(/|$))')),
  check (favorite or rating is not null or note is not null or hidden)
);
create table user_bookmarks (
  id bigserial primary key, user_id text not null references "user"(id) on delete cascade, root_id text not null references library_roots(id) on delete restrict,
  source_key varchar(4096) not null check (source_key <> '' and source_key !~ E'\\x00' and source_key !~ '(^/|//|(^|/)\\.\\.?(/|$))'),
  page_ordinal integer not null check (page_ordinal between 0 and 1000000), label varchar(256), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,root_id,source_key,page_ordinal)
);
create table user_collections (
  id bigserial primary key, user_id text not null references "user"(id) on delete cascade, name varchar(128) not null, name_key varchar(256) not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(user_id,name_key), unique(id,user_id)
);
create table user_collection_members (
  collection_id bigint not null, user_id text not null references "user"(id) on delete cascade, root_id text not null references library_roots(id) on delete restrict,
  target_kind user_target_kind not null, target_key varchar(4096) not null, created_at timestamptz not null default now(),
  primary key(collection_id,root_id,target_kind,target_key), foreign key(collection_id,user_id) references user_collections(id,user_id) on delete cascade,
  check ((target_kind = 'series' and target_key ~ '^[0-9a-f]{64}$') or (target_kind = 'publication' and target_key ~ '^[0-9a-f]{64}:[0-9a-f]{64}$') or (target_kind in ('check','source') and target_key <> '' and target_key !~ E'\\x00' and target_key !~ '(^/|//|(^|/)\\.\\.?(/|$))'))
);
create index user_progress_resume_idx on user_progress(user_id,root_id,last_read_at desc);
create index user_progress_history_idx on user_progress(user_id,last_read_at desc);
create index user_target_state_hide_idx on user_target_state(user_id,root_id,target_kind,target_key) where hidden;
create index user_target_state_favorite_idx on user_target_state(user_id,root_id,target_kind,target_key) where favorite;
create index user_target_state_entity_idx on user_target_state(user_id,root_id,target_kind,target_key);

grant select,insert,update,delete on gutter_user_state_revisions,user_progress,user_target_state,user_bookmarks,user_collections,user_collection_members to gutter_api;
-- Catalog hydration reads this projection directly; API receives no mutation authority.
grant select on global_source_suppressions to gutter_api;
grant usage,select on user_bookmarks_id_seq,user_collections_id_seq to gutter_api;
revoke all on gutter_user_state_revisions,user_progress,user_target_state,user_bookmarks,user_collections,user_collection_members from gutter_worker;
revoke all on sequence user_bookmarks_id_seq,user_collections_id_seq from gutter_worker;
-- Worker authorization is mediated by SECURITY DEFINER predicates; it must not read
-- suppression or user-state policy tables directly.
revoke all on global_source_suppressions from gutter_worker;

-- Worker authorization is deliberately mediated by this fixed, SECURITY DEFINER predicate;
-- worker has no direct access to user-state or ACL policy tables.
create or replace function gutter_user_can_read_release(p_user_id text, p_release_id bigint)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists (
    select 1
    from catalog_releases r
    join catalog_publications p on p.id=r.publication_id
    join catalog_series s on s.id=p.series_id
    join visible_source_items i on i.id=r.source_item_id
    join "user" u on u.id=p_user_id and not coalesce(u.banned,false)
    join library_roots lr on lr.id=r.root_id and lr.active
    where r.id=p_release_id
      and (u.role='admin' or exists (select 1 from library_access_grants g where g.user_id=p_user_id and g.root_id=r.root_id))
      and not exists (select 1 from global_source_suppressions gs where gs.source_item_id=i.id)
      and not exists (select 1 from user_target_state h where h.user_id=p_user_id and h.root_id=r.root_id and h.hidden and
        ((h.target_kind='series' and h.target_key=s.identity_key) or
         (h.target_kind='publication' and h.target_key=s.identity_key || ':' || p.identity_key) or
         (h.target_kind in ('source','check') and h.target_key=i.relative_path)))
  );
$$;
revoke all on function gutter_user_can_read_release(text,bigint) from public;
grant execute on function gutter_user_can_read_release(text,bigint) to gutter_api,gutter_worker;
insert into gutter_schema (version) values ('0010_user_state') on conflict (version) do nothing;

create table if not exists gutter_user_state_audit (
 id bigserial primary key, actor_user_id text not null references "user"(id), subject_user_id text not null references "user"(id),
 action text not null check (action in ('permanent_delete')), request_id text not null unique check (length(request_id) between 1 and 128), occurred_at timestamptz not null default now()
);
create or replace function gutter_reject_user_state_audit_mutation() returns trigger language plpgsql as $$ begin raise exception 'gutter_user_state_audit is append-only'; end $$;
drop trigger if exists gutter_user_state_audit_immutable on gutter_user_state_audit;
create trigger gutter_user_state_audit_immutable before update or delete on gutter_user_state_audit for each statement execute function gutter_reject_user_state_audit_mutation();
grant insert on gutter_user_state_audit to gutter_api;
grant usage,select on sequence gutter_user_state_audit_id_seq to gutter_api;
revoke all on gutter_user_state_audit from gutter_worker;

-- Forward hardening for the released 0009 ACL schema. Keep 0009 immutable. Request claims
-- provide idempotency without imposing a unique constraint on the append-only audit history.
create table if not exists gutter_acl_request_claims (
  request_id text primary key check (length(request_id) between 1 and 128),
  actor_user_id text not null references "user"(id) on delete restrict,
  subject_user_id text not null references "user"(id) on delete restrict,
  root_id text not null references library_roots(id) on delete restrict,
  action text not null check (action in ('grant','revoke')),
  revision bigint not null check (revision >= 0),
  claimed_at timestamptz not null default now()
);
create index if not exists gutter_acl_request_claims_subject_idx
  on gutter_acl_request_claims(subject_user_id,claimed_at);
revoke all on gutter_acl_request_claims from public, gutter_api, gutter_worker;

alter table gutter_acl_audit
  add constraint gutter_acl_audit_request_id_length check (length(request_id) between 1 and 128) not valid;
create or replace function gutter_change_library_access(p_actor text, p_subject text, p_root text, p_action text, p_request_id text)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare r bigint; claimed boolean; existing gutter_acl_request_claims%rowtype;
begin
 if p_action not in ('grant','revoke') or p_request_id is null or length(p_request_id) not between 1 and 128 then raise exception 'invalid_request_id'; end if;
 if not exists (select 1 from "user" where id=p_actor and role='admin' and not coalesce(banned,false)) then raise exception 'admin_required'; end if;
 insert into gutter_acl_request_claims(request_id,actor_user_id,subject_user_id,root_id,action,revision)
   values(p_request_id,p_actor,p_subject,p_root,p_action,0) on conflict (request_id) do nothing;
 claimed := found;
 if not claimed then
   select * into existing from gutter_acl_request_claims where request_id=p_request_id for update;
   if existing.actor_user_id<>p_actor or existing.subject_user_id<>p_subject or existing.root_id<>p_root or existing.action<>p_action then raise exception 'request_id_conflict'; end if;
   return existing.revision;
 end if;
 if p_action='grant' then insert into library_access_grants(user_id,root_id,granted_by_user_id) values(p_subject,p_root,p_actor) on conflict do nothing;
 else delete from library_access_grants where user_id=p_subject and root_id=p_root; end if;
 if found then
   insert into gutter_acl_revisions(user_id,revision) values(p_subject,1) on conflict(user_id) do update set revision=gutter_acl_revisions.revision+1,updated_at=now() returning revision into r;
   insert into gutter_acl_audit(actor_user_id,subject_user_id,root_id,action,request_id) values(p_actor,p_subject,p_root,p_action,p_request_id);
 else select revision into r from gutter_acl_revisions where user_id=p_subject; r:=coalesce(r,0); end if;
 update gutter_acl_request_claims set revision=r where request_id=p_request_id;
 return r;
end $$;
revoke all on function gutter_change_library_access(text,text,text,text,text) from public;
grant execute on function gutter_change_library_access(text,text,text,text,text) to gutter_api;
revoke insert,delete on library_access_grants from gutter_api;
revoke insert,update on gutter_acl_revisions from gutter_api;
revoke insert on gutter_acl_audit from gutter_api;
