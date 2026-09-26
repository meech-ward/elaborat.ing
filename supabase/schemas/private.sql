-- Helpers that the Data API must never expose. The `private` schema is not in
-- the API's exposed schemas; public wrapper functions call into it. Signed-in
-- users can still execute these functions, so every one of them checks the
-- caller itself and never trusts an argument to say who the caller is.
create schema private;

revoke all on schema private from public;
grant usage on schema private to authenticated;

-- A valid path inside a project: 1 to 1024 bytes of NFC-normalized text; no
-- leading, trailing or doubled slash; no segment starting with a dot; no
-- backslash, colon or control characters.
create function private.is_valid_path(path text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select path is not null
    and octet_length(path) between 1 and 1024
    and path is nfc normalized
    and path !~ '(^/|/$|//|(^|/)\.|[\\:[:cntrl:]])'
$$;

revoke all on function private.is_valid_path(text) from public, anon;
grant execute on function private.is_valid_path(text) to authenticated;

-- The folders above a path: 'a/b/c.md' gives {'a', 'a/b'}.
create function private.path_ancestors(path text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(array_to_string(parts[1:i], '/') order by i), '{}')
  from (select string_to_array(path, '/') as parts) s,
    generate_series(1, cardinality(s.parts) - 1) as i
$$;

revoke all on function private.path_ancestors(text) from public, anon;
grant execute on function private.path_ancestors(text) to authenticated;

-- Projects the caller can read: the ones they own and the ones shared with
-- them that they have accepted. RLS policies use this as
-- `project_id in (select private.readable_project_ids())`, which Postgres runs
-- once per query rather than once per row.
create function private.readable_project_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.projects p
  where p.owner_id = (select auth.uid())
  union
  select m.project_id
  from public.project_members m
  where m.user_id = (select auth.uid())
    and m.accepted_at is not null
$$;

revoke all on function private.readable_project_ids() from public, anon;
grant execute on function private.readable_project_ids() to authenticated;

-- The caller's role in a project: 'owner', 'editor', 'commenter', 'viewer', or
-- null when they have no access (including invitations not yet accepted).
create function private.project_role(project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select 'owner'
      from public.projects p
      where p.id = project_role.project_id
        and p.owner_id = (select auth.uid())
    ),
    (
      select m.role
      from public.project_members m
      where m.project_id = project_role.project_id
        and m.user_id = (select auth.uid())
        and m.accepted_at is not null
    )
  )
$$;

revoke all on function private.project_role(uuid) from public, anon;
grant execute on function private.project_role(uuid) to authenticated;

-- True when the request's JWT was issued to an OAuth client: an agent such as
-- Claude or ChatGPT connected through the Supabase OAuth 2.1 server.
create function private.is_oauth_client()
returns boolean
language sql
stable
set search_path = ''
as $$
  select nullif((select auth.jwt()) ->> 'client_id', '') is not null
$$;

revoke all on function private.is_oauth_client() from public, anon;
grant execute on function private.is_oauth_client() to authenticated;

-- The signed-in user's id, or an error for anonymous callers.
create function private.require_user()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  return uid;
end;
$$;

revoke all on function private.require_user() from public, anon;
grant execute on function private.require_user() to authenticated;
