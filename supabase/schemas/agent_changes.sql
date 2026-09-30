-- Agent changes: the file versions agents saved in a project, for the app's
-- Agent changes view, and each person's marker of how far they have looked
-- there, so the project can show how many are new to them.

-- The project revision up to which a person has looked at a project's agent
-- changes: versions above it are new to them. One row per person and
-- project. Its person reads it while they can read the project; only
-- mark_agent_changes_seen writes it.
create table public.agent_changes_seen (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seen_version bigint not null,
  seen_at timestamptz not null default now(),
  primary key (project_id, user_id),
  constraint agent_changes_seen_version_nonnegative check (seen_version >= 0)
);

create index agent_changes_seen_user_id_idx on public.agent_changes_seen (user_id);

alter table public.agent_changes_seen enable row level security;

revoke all on table public.agent_changes_seen from anon, authenticated;
grant select on table public.agent_changes_seen to authenticated;

create policy "People can read their own agent changes marker"
  on public.agent_changes_seen
  for select
  to authenticated
  using (user_id = (select auth.uid()) and project_id in (select private.readable_project_ids()));

-- The project, when the caller can read it, or an error that says the same
-- for a missing project and one they cannot read.
create function private.agent_changes_project(project_id uuid)
returns public.projects
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.projects;
begin
  perform private.require_user();
  select * into p from public.projects where id = agent_changes_project.project_id;
  if p.id is null or private.project_role(p.id) is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  return p;
end;
$$;

revoke all on function private.agent_changes_project(uuid) from public, anon;
grant execute on function private.agent_changes_project(uuid) to authenticated;

-- The caller's marker in a project, or 0 before they first look.
create function private.agent_changes_seen_version(project_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.seen_version from public.agent_changes_seen s
     where s.project_id = agent_changes_seen_version.project_id and s.user_id = (select auth.uid())),
    0
  )
$$;

revoke all on function private.agent_changes_seen_version(uuid) from public, anon, authenticated;

-- A project's file versions saved by agents, newest first, for anyone who
-- can read the project. A page holds the `max_count` newest revisions with
-- agent versions (1 to 50, 20 by default) below `before` when it is given,
-- with every file saved at each of them, so a save of several files is never
-- split between pages; `more` says whether older ones remain. Each change
-- has the person and the agent's name (never its client id), its content,
-- the file's previous version (null when the agent created the file),
-- whether it is still the file's latest version, and the thread whose reply
-- links it. `seen` is the caller's marker: changes above it are new to them.
create function private.list_agent_changes(project_id uuid, before bigint default null, max_count integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.projects := private.agent_changes_project(list_agent_changes.project_id);
  page_size integer := least(greatest(coalesce(list_agent_changes.max_count, 20), 1), 50);
  revisions bigint[];
begin
  select coalesce(array_agg(r.version order by r.version desc), '{}') into revisions
  from (
    select distinct v.version
    from public.file_versions v
    where v.project_id = p.id
      and v.agent_client_id is not null
      and (list_agent_changes.before is null or v.version < list_agent_changes.before)
    order by v.version desc
    limit page_size + 1
  ) r;
  return jsonb_build_object(
    'project_id', p.id,
    'revision', p.revision,
    'seen', private.agent_changes_seen_version(p.id),
    'more', cardinality(revisions) > page_size,
    'changes', coalesce(
      (select jsonb_agg(
         jsonb_build_object(
           'file_id', v.file_id,
           'version', v.version,
           'path', v.path,
           'deleted', v.deleted,
           'content', v.content,
           'created_at', v.created_at,
           'author', private.comment_person(v.author_id),
           'agent', private.agent_name(v.agent_client_id),
           'latest', not exists (
             select 1 from public.file_versions n where n.file_id = v.file_id and n.version > v.version
           ),
           'previous', (
             select jsonb_build_object('version', pv.version, 'path', pv.path, 'deleted', pv.deleted, 'content', pv.content)
             from public.file_versions pv
             where pv.file_id = v.file_id and pv.version < v.version
             order by pv.version desc
             limit 1
           ),
           'thread', (
             select jsonb_build_object(
               'id', t.id,
               'comment_id', c.id,
               'opening', (
                 select left(o.body, 200) from public.comments o
                 where o.thread_id = t.id
                 order by o.created_at, o.id
                 limit 1
               )
             )
             from public.comments c
             join public.comment_threads t on t.id = c.thread_id
             where c.project_id = p.id
               and t.file_id = v.file_id
               and c.file_version = v.version
               and c.deleted_at is null
             order by c.created_at, c.id
             limit 1
           )
         )
         order by v.version desc, v.path
       )
       from public.file_versions v
       where v.project_id = p.id
         and v.agent_client_id is not null
         and v.version = any (revisions[1:page_size])),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function private.list_agent_changes(uuid, bigint, integer) from public, anon;
grant execute on function private.list_agent_changes(uuid, bigint, integer) to authenticated;

create function public.list_agent_changes(project_id uuid, before bigint default null, max_count integer default 20)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.list_agent_changes(project_id, before, max_count)
$$;

revoke all on function public.list_agent_changes(uuid, bigint, integer) from public, anon;
grant execute on function public.list_agent_changes(uuid, bigint, integer) to authenticated;

-- How many file versions agents saved in a project are new to the caller
-- (above their marker), up to 100, for the count on the project's Agent
-- changes button. Anyone who can read the project.
create function private.count_agent_changes(project_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.projects := private.agent_changes_project(count_agent_changes.project_id);
  seen bigint := private.agent_changes_seen_version(p.id);
begin
  return (
    select count(*)::integer from (
      select 1 from public.file_versions v
      where v.project_id = p.id and v.agent_client_id is not null and v.version > seen
      limit 100
    ) n
  );
end;
$$;

revoke all on function private.count_agent_changes(uuid) from public, anon;
grant execute on function private.count_agent_changes(uuid) to authenticated;

create function public.count_agent_changes(project_id uuid)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select private.count_agent_changes(project_id)
$$;

revoke all on function public.count_agent_changes(uuid) from public, anon;
grant execute on function public.count_agent_changes(uuid) to authenticated;

-- The caller has looked at a project's agent changes up to `version` (a
-- project revision, at most the current one). The marker only moves
-- forward, so an older window cannot move it back. Only a signed-in person
-- marks what they have seen, never an agent for them. It is the person's own
-- state, so the project's revision does not change.
create function private.mark_agent_changes_seen(project_id uuid, version bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  p public.projects;
  marked bigint;
begin
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can mark agent changes seen' using errcode = '42501';
  end if;
  if mark_agent_changes_seen.version is null or mark_agent_changes_seen.version < 0 then
    raise exception 'A version is required' using errcode = '22023';
  end if;
  p := private.agent_changes_project(mark_agent_changes_seen.project_id);
  insert into public.agent_changes_seen as s (project_id, user_id, seen_version)
  values (p.id, uid, least(mark_agent_changes_seen.version, p.revision))
  on conflict on constraint agent_changes_seen_pkey do update
    set seen_version = greatest(s.seen_version, excluded.seen_version), seen_at = now()
  returning s.seen_version into marked;
  return jsonb_build_object('project_id', p.id, 'seen', marked);
end;
$$;

revoke all on function private.mark_agent_changes_seen(uuid, bigint) from public, anon;
grant execute on function private.mark_agent_changes_seen(uuid, bigint) to authenticated;

create function public.mark_agent_changes_seen(project_id uuid, version bigint)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.mark_agent_changes_seen(project_id, version)
$$;

revoke all on function public.mark_agent_changes_seen(uuid, bigint) from public, anon;
grant execute on function public.mark_agent_changes_seen(uuid, bigint) to authenticated;
