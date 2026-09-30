-- Comments on files: on a whole file, a note's section (its heading), a text
-- selection, or a drawing element. See "Comments" in docs/architecture.md.
--
-- A thread holds the anchor, the file and whether it is resolved; its
-- comments are the opening comment and every reply. Anchors are stored once,
-- exactly as the app describes them, and never rewritten: every reader finds
-- them again in the text it shows, and a thread whose text is gone shows as
-- detached. Nothing is ever written into the file.
--
-- Threads hang off the file's id, not its path, so they follow a rename or a
-- move. There is no foreign key to the file: deleting a file (which any
-- editor or agent can do, and history can undo) keeps its threads, listed
-- under the file's last path.
--
-- Viewers read comments; commenters, editors and the owner write them. Agents
-- read, add, reply, resolve and reopen, and never edit or delete a comment:
-- both remove someone's words for good, and only a person does that.
--
-- A thread's creator can ask their agents to deal with it ("Ask an agent"):
-- their agents list the open threads they asked about (list_comments with
-- ask_agent), change the file, and reply with the version they saved. Only
-- the creator, as a person, turns it on or off, so one person's request never
-- reaches another person's agent.
--
-- Clients select through RLS; every write is a security definer function in
-- `private` behind a thin security invoker wrapper in `public`. Every write
-- that changes something raises the project revision, which the change
-- signal trigger (change_signals.sql) broadcasts, so open projects hear about
-- comments too.

-- An anchor, in the app's shape (src/features/comments/placement.ts):
--   {"kind": "document"}
--   {"kind": "section" | "text", "quote": <TextQuoteSelector>, "position": <TextPositionSelector>}
--   {"kind": "element", "element_id": "...", "label": "...", "point"?: {"x": 0.5, "y": 0.5}}
-- Checked step by step, so a malformed value is never cast, and never null:
-- a check constraint would let a null through.
create function private.is_valid_comment_anchor(anchor jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  anchor_keys text[];
  quote jsonb;
  quote_keys text[];
  place jsonb;
  place_keys text[];
  point jsonb;
  point_keys text[];
begin
  if jsonb_typeof(anchor) is distinct from 'object' or jsonb_typeof(anchor -> 'kind') is distinct from 'string' then
    return false;
  end if;
  select coalesce(array_agg(k), '{}') into anchor_keys from jsonb_object_keys(anchor) k;

  if anchor ->> 'kind' = 'document' then
    return anchor_keys <@ array['kind'];
  end if;

  if anchor ->> 'kind' in ('section', 'text') then
    if not (anchor_keys <@ array['kind', 'quote', 'position'] and array['kind', 'quote', 'position'] <@ anchor_keys) then
      return false;
    end if;
    quote := anchor -> 'quote';
    place := anchor -> 'position';
    if jsonb_typeof(quote) <> 'object' or jsonb_typeof(place) <> 'object' then
      return false;
    end if;
    select coalesce(array_agg(k), '{}') into quote_keys from jsonb_object_keys(quote) k;
    select coalesce(array_agg(k), '{}') into place_keys from jsonb_object_keys(place) k;
    if not (quote_keys <@ array['type', 'exact', 'prefix', 'suffix'] and array['type', 'exact', 'prefix', 'suffix'] <@ quote_keys)
      or not (place_keys <@ array['type', 'start', 'end'] and array['type', 'start', 'end'] <@ place_keys) then
      return false;
    end if;
    if jsonb_typeof(quote -> 'type') <> 'string' or quote ->> 'type' <> 'TextQuoteSelector'
      or jsonb_typeof(quote -> 'exact') <> 'string' or jsonb_typeof(quote -> 'prefix') <> 'string'
      or jsonb_typeof(quote -> 'suffix') <> 'string' then
      return false;
    end if;
    -- 32 UTF-16 code units of context are never more than 32 characters.
    if char_length(quote ->> 'exact') < 1 or char_length(quote ->> 'exact') > 5000
      or char_length(quote ->> 'prefix') > 32 or char_length(quote ->> 'suffix') > 32 then
      return false;
    end if;
    if jsonb_typeof(place -> 'type') <> 'string' or place ->> 'type' <> 'TextPositionSelector'
      or jsonb_typeof(place -> 'start') <> 'number' or jsonb_typeof(place -> 'end') <> 'number' then
      return false;
    end if;
    -- Whole numbers only, and never past the largest file (2 MiB).
    if (place ->> 'start') !~ '^(0|[1-9][0-9]{0,6})$' or (place ->> 'end') !~ '^(0|[1-9][0-9]{0,6})$' then
      return false;
    end if;
    return (place ->> 'start')::integer < (place ->> 'end')::integer and (place ->> 'end')::integer <= 2097152;
  end if;

  if anchor ->> 'kind' = 'element' then
    if not (anchor_keys <@ array['kind', 'element_id', 'label', 'point'] and array['kind', 'element_id', 'label'] <@ anchor_keys) then
      return false;
    end if;
    if jsonb_typeof(anchor -> 'element_id') <> 'string' or jsonb_typeof(anchor -> 'label') <> 'string' then
      return false;
    end if;
    if char_length(anchor ->> 'element_id') < 1 or char_length(anchor ->> 'element_id') > 256
      or char_length(anchor ->> 'label') > 200 then
      return false;
    end if;
    if not (anchor ? 'point') then
      return true;
    end if;
    point := anchor -> 'point';
    if jsonb_typeof(point) <> 'object' then
      return false;
    end if;
    select coalesce(array_agg(k), '{}') into point_keys from jsonb_object_keys(point) k;
    if not (point_keys <@ array['x', 'y'] and array['x', 'y'] <@ point_keys)
      or jsonb_typeof(point -> 'x') <> 'number' or jsonb_typeof(point -> 'y') <> 'number' then
      return false;
    end if;
    return (point ->> 'x')::numeric >= 0 and (point ->> 'x')::numeric <= 1
      and (point ->> 'y')::numeric >= 0 and (point ->> 'y')::numeric <= 1;
  end if;

  return false;
end;
$$;

revoke all on function private.is_valid_comment_anchor(jsonb) from public, anon;
grant execute on function private.is_valid_comment_anchor(jsonb) to authenticated;

-- A comment thread on one file. The client chooses the id, so a retried add
-- never starts a second thread. `file_version` is the saved version the anchor
-- was described against.
create table public.comment_threads (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  -- project_files.id, with no foreign key: see the top of this file.
  file_id uuid not null,
  file_version bigint not null,
  anchor jsonb not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  -- Ask an agent: the project revision at which the creator last asked, when
  -- they turned it on or replied while it was on; null when it is off. It is
  -- the cursor list_comments's ask_agent filter compares with `since`.
  ask_agent_revision bigint,
  constraint comment_threads_anchor_valid check (private.is_valid_comment_anchor(anchor)),
  constraint comment_threads_file_version_positive check (file_version > 0)
);

create index comment_threads_project_file_idx on public.comment_threads (project_id, file_id);
create index comment_threads_created_by_idx on public.comment_threads (created_by);
create index comment_threads_resolved_by_idx on public.comment_threads (resolved_by);

alter table public.comment_threads enable row level security;

revoke all on table public.comment_threads from anon, authenticated;
grant select on table public.comment_threads to authenticated;

create policy "People can read comment threads in their projects"
  on public.comment_threads
  for select
  to authenticated
  using (project_id in (select private.readable_project_ids()));

-- The opening comment of a thread and every reply. A deleted comment keeps
-- its row, without its body, while its thread has live comments, so replies
-- keep their context. `agent_client_id` is the OAuth client that wrote it,
-- taken from the caller's token, never from an argument. Readers see only
-- whether an agent wrote it and the agent's name (`via_agent` and `agent` in
-- list_comments), so it is the one column they cannot select. `file_version`
-- is a version of the thread's file the reply links to: the one an agent
-- saved in answer.
create table public.comments (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.comment_threads (id) on delete cascade,
  -- Always the thread's project, for RLS.
  project_id uuid not null references public.projects (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null,
  agent_client_id text,
  body text,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  file_version bigint,
  constraint comments_deleted_has_no_body check ((deleted_at is null) = (body is not null)),
  -- Not `between 1 and 5000`: next to another `and`, Postgres stores that
  -- nested, but the migration generated from it is stored flat, so
  -- regenerating migrations would always report a change.
  constraint comments_body_valid
    check (body is null or (char_length(body) >= 1 and char_length(body) <= 5000 and body ~ '\S')),
  constraint comments_agent_client_id_length check (agent_client_id is null or char_length(agent_client_id) <= 255),
  constraint comments_file_version_positive check (file_version is null or file_version > 0)
);

create index comments_thread_idx on public.comments (thread_id, created_at, id);
create index comments_project_id_idx on public.comments (project_id);
create index comments_author_id_idx on public.comments (author_id);

alter table public.comments enable row level security;

revoke all on table public.comments from anon, authenticated;
grant select (id, thread_id, project_id, author_id, body, created_at, edited_at, deleted_at, file_version)
  on table public.comments to authenticated;

create policy "People can read comments in their projects"
  on public.comments
  for select
  to authenticated
  using (project_id in (select private.readable_project_ids()));

-- The ids of a project's deleted threads, so an add repeated after its thread
-- was deleted says so instead of starting the thread again. Only the
-- functions below read or write it.
create table private.deleted_comment_threads (
  project_id uuid not null references public.projects (id) on delete cascade,
  id uuid not null,
  deleted_at timestamptz not null default now(),
  primary key (project_id, id)
);

alter table private.deleted_comment_threads enable row level security;

revoke all on table private.deleted_comment_threads from anon, authenticated;

-- Lock a project for a comment write by a commenter, editor or owner, or
-- raise. Viewers read comments but cannot write them.
create function private.lock_project_for_comment(project_id uuid, allow_archived boolean default false)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.projects;
  caller_role text;
begin
  perform private.require_user();
  select * into p from public.projects where id = lock_project_for_comment.project_id for update;
  caller_role := private.project_role(lock_project_for_comment.project_id);
  if p.id is null or caller_role is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  if caller_role not in ('owner', 'editor', 'commenter') then
    raise exception 'Commenting needs commenter access' using errcode = '42501';
  end if;
  if p.archived_at is not null and not lock_project_for_comment.allow_archived then
    raise exception 'Project is archived' using errcode = '55000';
  end if;
  return p;
end;
$$;

revoke all on function private.lock_project_for_comment(uuid, boolean) from public, anon;
grant execute on function private.lock_project_for_comment(uuid, boolean) to authenticated;

-- The project of a thread or comment, when the caller can read it. A missing
-- row and one in a project the caller cannot read give the same answer, so
-- ids cannot be probed.
create function private.comment_project(project_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if comment_project.project_id is null or private.project_role(comment_project.project_id) is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  return comment_project.project_id;
end;
$$;

revoke all on function private.comment_project(uuid) from public, anon;
grant execute on function private.comment_project(uuid) to authenticated;

-- A comment body: 1 to 5000 characters, not all blank.
create function private.check_comment_body(body text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if check_comment_body.body is null or char_length(check_comment_body.body) < 1
    or char_length(check_comment_body.body) > 5000 or check_comment_body.body !~ '\S' then
    raise exception 'A comment is 1 to 5000 characters' using errcode = '22023';
  end if;
end;
$$;

revoke all on function private.check_comment_body(text) from public, anon;
grant execute on function private.check_comment_body(text) to authenticated;

-- The name an account shows under: the one its person set in Settings
-- (`display_name` in its user metadata), else the one a sign-in provider gave
-- (`full_name`, then `name`), else its email. Metadata is the person's own to
-- change, so spaces are collapsed and the name cut to 80 characters.
create function private.person_name(metadata jsonb, email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (select named.name
     from (
       select nullif(left(btrim(regexp_replace(person_name.metadata ->> k.key, '\s+', ' ', 'g')), 80), '') as name, k.rank
       from unnest(array['display_name', 'full_name', 'name']) with ordinality as k(key, rank)
     ) named
     where named.name is not null
     order by named.rank
     limit 1),
    person_name.email
  )
$$;

revoke all on function private.person_name(jsonb, text) from public, anon, authenticated;

-- An account as comments show it, or null for a deleted account: its id,
-- email and name. These read auth.users, so only the definer functions below
-- call them, after they have checked the caller can read the project.
create function private.comment_person(user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', u.id,
    'email', u.email::text,
    'name', private.person_name(u.raw_user_meta_data, u.email::text)
  )
  from auth.users u
  where u.id = comment_person.user_id
$$;

revoke all on function private.comment_person(uuid) from public, anon, authenticated;

-- The name of the agent (OAuth client) with this id, as the person approved
-- it and Connected agents shows it, or null: for no client, or one without a
-- name. The client chose it, so spaces are collapsed and it is cut to 80
-- characters. If the client list cannot be read, it is null too, so a list
-- of comments never fails over a name.
create function private.agent_name(client_id text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  found text;
begin
  if agent_name.client_id is null
    or agent_name.client_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  begin
    select nullif(left(btrim(regexp_replace(c.client_name, '\s+', ' ', 'g')), 80), '') into found
    from auth.oauth_clients c
    where c.id = agent_name.client_id::uuid;
  exception when undefined_table or insufficient_privilege then
    return null;
  end;
  return found;
end;
$$;

revoke all on function private.agent_name(text) from public, anon, authenticated;

create function private.comment_json(c public.comments)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'author', private.comment_person(c.author_id),
    'via_agent', c.agent_client_id is not null,
    'agent', private.agent_name(c.agent_client_id),
    'body', c.body,
    'created_at', c.created_at,
    'edited_at', c.edited_at,
    'deleted_at', c.deleted_at,
    'file_version', c.file_version
  )
$$;

revoke all on function private.comment_json(public.comments) from public, anon, authenticated;

-- A thread with its comments, oldest first. `path` is the file's current
-- path, or for a deleted file the path of its last version, with
-- `file_deleted` true.
create function private.thread_json(t public.comment_threads)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id,
    'file_id', t.file_id,
    'path', coalesce(
      (select f.path from public.project_files f where f.id = t.file_id and f.project_id = t.project_id),
      (select v.path from public.file_versions v
       where v.file_id = t.file_id and v.project_id = t.project_id
       order by v.version desc limit 1)
    ),
    'file_deleted', not exists (
      select 1 from public.project_files f where f.id = t.file_id and f.project_id = t.project_id
    ),
    'file_version', t.file_version,
    'anchor', t.anchor,
    'created_at', t.created_at,
    'resolved_at', t.resolved_at,
    'resolved_by', private.comment_person(t.resolved_by),
    'ask_agent', t.ask_agent_revision is not null,
    'comments', coalesce(
      (select jsonb_agg(private.comment_json(c) order by c.created_at, c.id)
       from public.comments c where c.thread_id = t.id),
      '[]'::jsonb
    )
  )
$$;

revoke all on function private.thread_json(public.comment_threads) from public, anon, authenticated;

-- Every thread of a project, or of one file, with the project's current
-- revision. Anyone who can read the project may list, viewers included.
-- With `ask_agent`, only the open threads the caller started and asked an
-- agent about, never anyone else's; with `since` too (a revision this
-- returned before), only those asked after it.
create function private.list_comments(
  project_id uuid, file_id uuid default null, ask_agent boolean default false, since bigint default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  p public.projects;
begin
  if list_comments.since is not null and not coalesce(list_comments.ask_agent, false) then
    raise exception 'since works with ask_agent' using errcode = '22023';
  end if;
  select * into p from public.projects where id = list_comments.project_id;
  if p.id is null or private.project_role(p.id) is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'project_id', p.id,
    'revision', p.revision,
    'threads', coalesce(
      (select jsonb_agg(private.thread_json(t) order by t.created_at, t.id)
       from public.comment_threads t
       where t.project_id = p.id
         and (list_comments.file_id is null or t.file_id = list_comments.file_id)
         and (not coalesce(list_comments.ask_agent, false) or (
           t.created_by = uid
           and t.ask_agent_revision is not null
           and t.resolved_at is null
           and (list_comments.since is null or t.ask_agent_revision > list_comments.since)
         ))),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function private.list_comments(uuid, uuid, boolean, bigint) from public, anon;
grant execute on function private.list_comments(uuid, uuid, boolean, bigint) to authenticated;

create function public.list_comments(
  project_id uuid, file_id uuid default null, ask_agent boolean default false, since bigint default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.list_comments(project_id, file_id, ask_agent, since)
$$;

revoke all on function public.list_comments(uuid, uuid, boolean, bigint) from public, anon;
grant execute on function public.list_comments(uuid, uuid, boolean, bigint) to authenticated;

-- Start a thread on a file, with its opening comment. The client chooses the
-- thread id: repeating the call with the same id returns the thread as it is
-- now, even if the project was archived in between, or says it was deleted;
-- reusing the id for anything else is an error. The file must be a current
-- file of the project. An id taken in a project the caller cannot read goes
-- through every check a new id does and is refused only where a new id is
-- written, with "Comment unavailable", so such ids cannot be probed.
-- `ask_agent` starts it asking the caller's agents (a person only).
create function private.add_comment(
  project_id uuid, thread_id uuid, file_id uuid, file_version bigint, anchor jsonb, body text,
  ask_agent boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  p public.projects;
  t public.comment_threads;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if add_comment.project_id is null or add_comment.thread_id is null or add_comment.file_id is null
    or add_comment.file_version is null or add_comment.file_version <= 0 then
    raise exception 'Project, thread and file ids and a positive file version are required' using errcode = '22023';
  end if;
  perform private.check_comment_body(add_comment.body);
  if not coalesce(private.is_valid_comment_anchor(add_comment.anchor), false) then
    raise exception 'Invalid anchor' using errcode = '22023';
  end if;
  if coalesce(add_comment.ask_agent, false) and private.is_oauth_client() then
    raise exception 'Only a signed-in person can ask an agent' using errcode = '42501';
  end if;

  p := private.lock_project_for_comment(add_comment.project_id, true);

  select * into t from public.comment_threads ct
  where ct.id = add_comment.thread_id and ct.project_id in (select private.readable_project_ids());
  if t.id is not null then
    if t.project_id = p.id and t.file_id = add_comment.file_id and t.created_by = uid then
      return jsonb_build_object('revision', p.revision, 'thread', private.thread_json(t));
    end if;
    raise exception 'This comment id was already used' using errcode = '22023';
  end if;
  if exists (
    select 1 from private.deleted_comment_threads d where d.project_id = p.id and d.id = add_comment.thread_id
  ) then
    raise exception 'This comment was deleted' using errcode = '22023';
  end if;

  if p.archived_at is not null then
    raise exception 'Project is archived' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.project_files f where f.id = add_comment.file_id and f.project_id = p.id
  ) then
    raise exception 'No such file in this project' using errcode = '22023';
  end if;
  if (select count(*) from public.comment_threads ct
      where ct.project_id = p.id and ct.file_id = add_comment.file_id) >= 1000 then
    raise exception 'A file can have at most 1000 comment threads' using errcode = '54000';
  end if;
  if (select count(*) from public.comments c where c.project_id = p.id) >= 10000 then
    raise exception 'A project can hold at most 10000 comments' using errcode = '54000';
  end if;

  -- The project is locked, so this write takes the next revision.
  insert into public.comment_threads (id, project_id, file_id, file_version, anchor, created_by, ask_agent_revision)
  values (
    add_comment.thread_id, p.id, add_comment.file_id, add_comment.file_version, add_comment.anchor, uid,
    case when coalesce(add_comment.ask_agent, false) then p.revision + 1 end
  )
  on conflict (id) do nothing
  returning * into t;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  insert into public.comments (thread_id, project_id, author_id, agent_client_id, body)
  values (t.id, p.id, uid, nullif((select auth.jwt()) ->> 'client_id', ''), add_comment.body);

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'thread', private.thread_json(t));
end;
$$;

revoke all on function private.add_comment(uuid, uuid, uuid, bigint, jsonb, text, boolean) from public, anon;
grant execute on function private.add_comment(uuid, uuid, uuid, bigint, jsonb, text, boolean) to authenticated;

create function public.add_comment(
  project_id uuid, thread_id uuid, file_id uuid, file_version bigint, anchor jsonb, body text,
  ask_agent boolean default false
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.add_comment(project_id, thread_id, file_id, file_version, anchor, body, ask_agent)
$$;

revoke all on function public.add_comment(uuid, uuid, uuid, bigint, jsonb, text, boolean) from public, anon;
grant execute on function public.add_comment(uuid, uuid, uuid, bigint, jsonb, text, boolean) to authenticated;

-- Reply to a thread. The client chooses the comment id: repeating the call
-- with the same id returns that comment as it is now, even if it was edited
-- or deleted since. A comment id taken in a project the caller cannot read is
-- refused as add_comment refuses such a thread id. `file_version` links the
-- reply to a saved version of the thread's file, such as the one an agent
-- saved in answer. The creator's own reply, as a person, to a thread asking
-- an agent asks again, so their agents list it after their last cursor.
create function private.reply_comment(thread_id uuid, comment_id uuid, body text, file_version bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  p public.projects;
  t public.comment_threads;
  c public.comments;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if reply_comment.thread_id is null or reply_comment.comment_id is null then
    raise exception 'Thread and comment ids are required' using errcode = '22023';
  end if;
  perform private.check_comment_body(reply_comment.body);

  p := private.lock_project_for_comment(
    private.comment_project((select ct.project_id from public.comment_threads ct where ct.id = reply_comment.thread_id)),
    true
  );
  -- Every comment write locks the project first, so the thread cannot change now.
  select * into t from public.comment_threads ct where ct.id = reply_comment.thread_id and ct.project_id = p.id;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;

  select * into c from public.comments cm
  where cm.id = reply_comment.comment_id and cm.project_id in (select private.readable_project_ids());
  if c.id is not null then
    if c.thread_id = t.id and c.author_id = uid then
      return jsonb_build_object('revision', p.revision, 'comment', private.comment_json(c));
    end if;
    raise exception 'This comment id was already used' using errcode = '22023';
  end if;

  if p.archived_at is not null then
    raise exception 'Project is archived' using errcode = '55000';
  end if;
  if reply_comment.file_version is not null and not exists (
    select 1 from public.file_versions v
    where v.project_id = p.id and v.file_id = t.file_id and v.version = reply_comment.file_version
  ) then
    raise exception 'No such version of this file' using errcode = '22023';
  end if;
  if (select count(*) from public.comments cm where cm.project_id = p.id) >= 10000 then
    raise exception 'A project can hold at most 10000 comments' using errcode = '54000';
  end if;

  insert into public.comments (id, thread_id, project_id, author_id, agent_client_id, body, file_version)
  values (
    reply_comment.comment_id, t.id, p.id, uid, nullif((select auth.jwt()) ->> 'client_id', ''), reply_comment.body,
    reply_comment.file_version
  )
  on conflict (id) do nothing
  returning * into c;
  if c.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  if t.created_by = uid and t.ask_agent_revision is not null and not private.is_oauth_client() then
    update public.comment_threads ct set ask_agent_revision = new_revision where ct.id = t.id;
  end if;
  return jsonb_build_object('revision', new_revision, 'comment', private.comment_json(c));
end;
$$;

revoke all on function private.reply_comment(uuid, uuid, text, bigint) from public, anon;
grant execute on function private.reply_comment(uuid, uuid, text, bigint) to authenticated;

create function public.reply_comment(thread_id uuid, comment_id uuid, body text, file_version bigint default null)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.reply_comment(thread_id, comment_id, body, file_version)
$$;

revoke all on function public.reply_comment(uuid, uuid, text, bigint) from public, anon;
grant execute on function public.reply_comment(uuid, uuid, text, bigint) to authenticated;

-- Turn Ask an agent on or off for a thread. Only the thread's creator, and
-- only as a person: an agent never asks itself, and no one asks another
-- person's agents. Setting it to what it is changes nothing.
create function private.set_comment_ask_agent(thread_id uuid, ask boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  p public.projects;
  t public.comment_threads;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can ask an agent' using errcode = '42501';
  end if;
  if set_comment_ask_agent.thread_id is null or set_comment_ask_agent.ask is null then
    raise exception 'Thread id and ask are required' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(
    private.comment_project((select ct.project_id from public.comment_threads ct where ct.id = set_comment_ask_agent.thread_id))
  );
  select * into t from public.comment_threads ct where ct.id = set_comment_ask_agent.thread_id and ct.project_id = p.id;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if t.created_by is distinct from uid then
    raise exception 'Only the person who started a thread can ask an agent about it' using errcode = '42501';
  end if;
  if (t.ask_agent_revision is not null) = set_comment_ask_agent.ask then
    return jsonb_build_object('revision', p.revision, 'thread', private.thread_json(t));
  end if;

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  update public.comment_threads ct
  set ask_agent_revision = case when set_comment_ask_agent.ask then new_revision end
  where ct.id = t.id
  returning * into t;
  return jsonb_build_object('revision', new_revision, 'thread', private.thread_json(t));
end;
$$;

revoke all on function private.set_comment_ask_agent(uuid, boolean) from public, anon;
grant execute on function private.set_comment_ask_agent(uuid, boolean) to authenticated;

create function public.set_comment_ask_agent(thread_id uuid, ask boolean)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.set_comment_ask_agent(thread_id, ask)
$$;

revoke all on function public.set_comment_ask_agent(uuid, boolean) from public, anon;
grant execute on function public.set_comment_ask_agent(uuid, boolean) to authenticated;

-- Change a comment's words. Only its author, and only in a normal session:
-- no history is kept, so an agent would erase its person's words and show its
-- own as theirs. `edited_at` shows it was edited.
create function private.edit_comment(comment_id uuid, body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  p public.projects;
  c public.comments;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can edit comments; agents can reply' using errcode = '42501';
  end if;
  if edit_comment.comment_id is null then
    raise exception 'Comment id required' using errcode = '22023';
  end if;
  perform private.check_comment_body(edit_comment.body);

  p := private.lock_project_for_comment(
    private.comment_project((select cm.project_id from public.comments cm where cm.id = edit_comment.comment_id))
  );
  select * into c from public.comments cm where cm.id = edit_comment.comment_id and cm.project_id = p.id;
  if c.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if c.author_id is distinct from uid then
    raise exception 'Only its author can edit a comment' using errcode = '42501';
  end if;
  if c.deleted_at is not null then
    raise exception 'This comment was deleted' using errcode = '22023';
  end if;
  if c.body = edit_comment.body then
    return jsonb_build_object('revision', p.revision, 'comment', private.comment_json(c));
  end if;

  update public.comments cm set body = edit_comment.body, edited_at = now()
  where cm.id = c.id
  returning * into c;
  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'comment', private.comment_json(c));
end;
$$;

revoke all on function private.edit_comment(uuid, text) from public, anon;
grant execute on function private.edit_comment(uuid, text) to authenticated;

create function public.edit_comment(comment_id uuid, body text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.edit_comment(comment_id, body)
$$;

revoke all on function public.edit_comment(uuid, text) from public, anon;
grant execute on function public.edit_comment(uuid, text) to authenticated;

-- Resolve or reopen a thread. Anyone who can comment may, agents included.
-- Resolving a resolved thread, or reopening an open one, changes nothing.
create function private.set_comment_resolved(thread_id uuid, resolved boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  p public.projects;
  t public.comment_threads;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if set_comment_resolved.thread_id is null or set_comment_resolved.resolved is null then
    raise exception 'Thread id and resolved are required' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(
    private.comment_project((select ct.project_id from public.comment_threads ct where ct.id = set_comment_resolved.thread_id))
  );
  select * into t from public.comment_threads ct where ct.id = set_comment_resolved.thread_id and ct.project_id = p.id;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if (t.resolved_at is not null) = set_comment_resolved.resolved then
    return jsonb_build_object('revision', p.revision, 'thread', private.thread_json(t));
  end if;

  update public.comment_threads ct
  set resolved_at = case when set_comment_resolved.resolved then now() end,
      resolved_by = case when set_comment_resolved.resolved then uid end
  where ct.id = t.id
  returning * into t;
  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'thread', private.thread_json(t));
end;
$$;

revoke all on function private.set_comment_resolved(uuid, boolean) from public, anon;
grant execute on function private.set_comment_resolved(uuid, boolean) to authenticated;

create function public.resolve_comment(thread_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.set_comment_resolved(thread_id, true)
$$;

revoke all on function public.resolve_comment(uuid) from public, anon;
grant execute on function public.resolve_comment(uuid) to authenticated;

create function public.reopen_comment(thread_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.set_comment_resolved(thread_id, false)
$$;

revoke all on function public.reopen_comment(uuid) from public, anon;
grant execute on function public.reopen_comment(uuid) to authenticated;

-- Delete a comment's words for good. Its author or the project owner, and only
-- in a normal session: tokens issued to OAuth clients (agents) are refused.
-- While the thread has other live comments the row stays as a placeholder
-- ("Comment deleted"); when the last live comment goes, the thread goes too.
create function private.delete_comment(comment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  p public.projects;
  c public.comments;
  thread_deleted boolean := false;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can delete comments; agents can resolve them' using errcode = '42501';
  end if;
  if delete_comment.comment_id is null then
    raise exception 'Comment id required' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(
    private.comment_project((select cm.project_id from public.comments cm where cm.id = delete_comment.comment_id))
  );
  select * into c from public.comments cm where cm.id = delete_comment.comment_id and cm.project_id = p.id;
  if c.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if c.author_id is distinct from uid and p.owner_id <> uid then
    raise exception 'Only its author or the project owner can delete a comment' using errcode = '42501';
  end if;
  if c.deleted_at is not null then
    return jsonb_build_object('revision', p.revision, 'comment_id', c.id, 'thread_deleted', false);
  end if;

  update public.comments cm set body = null, deleted_at = now() where cm.id = c.id;
  if not exists (
    select 1 from public.comments cm where cm.thread_id = c.thread_id and cm.deleted_at is null
  ) then
    delete from public.comment_threads ct where ct.id = c.thread_id;
    insert into private.deleted_comment_threads (project_id, id) values (p.id, c.thread_id)
      on conflict do nothing;
    thread_deleted := true;
  end if;

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'comment_id', c.id, 'thread_deleted', thread_deleted);
end;
$$;

revoke all on function private.delete_comment(uuid) from public, anon;
grant execute on function private.delete_comment(uuid) to authenticated;

create function public.delete_comment(comment_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.delete_comment(comment_id)
$$;

revoke all on function public.delete_comment(uuid) from public, anon;
grant execute on function public.delete_comment(uuid) to authenticated;

-- Delete a whole thread. The owner deletes any; the thread's creator deletes
-- it only while every live comment in it is theirs. People only, never agents.
create function private.delete_comment_thread(thread_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  p public.projects;
  t public.comment_threads;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can delete comments; agents can resolve them' using errcode = '42501';
  end if;
  if delete_comment_thread.thread_id is null then
    raise exception 'Thread id required' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(
    private.comment_project((select ct.project_id from public.comment_threads ct where ct.id = delete_comment_thread.thread_id))
  );
  select * into t from public.comment_threads ct where ct.id = delete_comment_thread.thread_id and ct.project_id = p.id;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if p.owner_id <> uid and (
    t.created_by is distinct from uid
    or exists (
      select 1 from public.comments cm
      where cm.thread_id = t.id and cm.deleted_at is null and cm.author_id is distinct from uid
    )
  ) then
    raise exception 'Only the project owner can delete a thread with other people''s comments' using errcode = '42501';
  end if;

  delete from public.comment_threads ct where ct.id = t.id;
  insert into private.deleted_comment_threads (project_id, id) values (p.id, t.id)
    on conflict do nothing;
  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'thread_id', t.id, 'deleted', true);
end;
$$;

revoke all on function private.delete_comment_thread(uuid) from public, anon;
grant execute on function private.delete_comment_thread(uuid) to authenticated;

create function public.delete_comment_thread(thread_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.delete_comment_thread(thread_id)
$$;

revoke all on function public.delete_comment_thread(uuid) from public, anon;
grant execute on function public.delete_comment_thread(uuid) to authenticated;
