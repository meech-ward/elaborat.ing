-- A project is one user's space for related notes, drawings and diagrams. It is
-- also the unit of sharing. `revision` goes up by one with every change, and
-- each file's version is the revision at which it last changed.
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  revision bigint not null default 0,
  content_bytes bigint not null default 0,
  archived_at timestamptz,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Not `between 1 and 160`: next to another `and`, Postgres stores that nested,
  -- but the migration generated from it is stored flat, so regenerating
  -- migrations would always report a change.
  constraint projects_title_valid
    check (char_length(title) >= 1 and char_length(title) <= 160 and title ~ '\S'),
  constraint projects_revision_nonnegative check (revision >= 0),
  constraint projects_content_bytes_limit check (content_bytes between 0 and 67108864)
);

create index projects_owner_id_idx on public.projects (owner_id);

alter table public.projects enable row level security;

revoke all on table public.projects from anon, authenticated;
grant select on table public.projects to authenticated;

create policy "People can read projects they own or have joined"
  on public.projects
  for select
  to authenticated
  using (id in (select private.readable_project_ids()));

-- People a project is shared with. The owner is not listed here. A share is an
-- invitation until the invited person accepts it (`accepted_at`); until then
-- it grants no access.
create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (project_id, user_id),
  constraint project_members_role_valid check (role in ('viewer', 'commenter', 'editor'))
);

create index project_members_user_id_idx on public.project_members (user_id);

alter table public.project_members enable row level security;

revoke all on table public.project_members from anon, authenticated;
grant select on table public.project_members to authenticated;

create policy "People can see members of their projects and their own invites"
  on public.project_members
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or project_id in (select private.readable_project_ids())
  );
