-- One row per file, holding its current content. `version` is the project
-- revision at which the file last changed, so a path and version pair always
-- identifies one exact write. Paths use the "C" collation: byte order, which
-- also lets prefix lookups use the unique index.
create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  path text collate "C" not null,
  content text not null,
  version bigint not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint project_files_project_path_key unique (project_id, path),
  constraint project_files_path_valid check (private.is_valid_path(path)),
  constraint project_files_content_size check (octet_length(content) <= 2097152),
  constraint project_files_version_positive check (version > 0)
);

create index project_files_updated_by_idx on public.project_files (updated_by);

alter table public.project_files enable row level security;

revoke all on table public.project_files from anon, authenticated;
grant select on table public.project_files to authenticated;

create policy "People can read files in their projects"
  on public.project_files
  for select
  to authenticated
  using (project_id in (select private.readable_project_ids()));

-- Every saved version of every file, including deletions, so nothing an agent or
-- a person does to a file is unrecoverable. Rows are only ever inserted.
-- `agent_client_id` is the OAuth client (agent) that saved it, taken from the
-- caller's token, and null for a save from the app. As for comments, readers
-- see only the agent's name (list_file_authors), so it is the one column they
-- cannot select.
create table public.file_versions (
  file_id uuid not null,
  version bigint not null,
  project_id uuid not null references public.projects (id) on delete cascade,
  path text collate "C" not null,
  content text,
  deleted boolean not null default false,
  author_id uuid references auth.users (id) on delete set null,
  mutation_id uuid not null,
  created_at timestamptz not null default now(),
  agent_client_id text,
  primary key (file_id, version),
  constraint file_versions_version_positive check (version > 0),
  constraint file_versions_content_matches_deleted check (deleted = (content is null)),
  constraint file_versions_agent_client_id_length check (agent_client_id is null or char_length(agent_client_id) <= 255)
);

create index file_versions_project_id_idx on public.file_versions (project_id);
create index file_versions_author_id_idx on public.file_versions (author_id);

alter table public.file_versions enable row level security;

revoke all on table public.file_versions from anon, authenticated;
grant select (file_id, version, project_id, path, content, deleted, author_id, mutation_id, created_at)
  on table public.file_versions to authenticated;

create policy "People can read file history in their projects"
  on public.file_versions
  for select
  to authenticated
  using (project_id in (select private.readable_project_ids()));

-- Folders that exist on their own, such as empty ones. Folders that contain
-- files exist implicitly through the file paths.
create table public.project_folders (
  project_id uuid not null references public.projects (id) on delete cascade,
  path text collate "C" not null,
  created_at timestamptz not null default now(),
  primary key (project_id, path),
  constraint project_folders_path_valid check (private.is_valid_path(path))
);

alter table public.project_folders enable row level security;

revoke all on table public.project_folders from anon, authenticated;
grant select on table public.project_folders to authenticated;

create policy "People can read folders in their projects"
  on public.project_folders
  for select
  to authenticated
  using (project_id in (select private.readable_project_ids()));

-- The result of each successful save, keyed by the client's mutation id, so a
-- retried save returns its original result instead of saving twice.
create table private.save_receipts (
  project_id uuid not null references public.projects (id) on delete cascade,
  mutation_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  payload_hash bytea not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (project_id, mutation_id)
);

create index save_receipts_user_id_idx on private.save_receipts (user_id);

alter table private.save_receipts enable row level security;

revoke all on table private.save_receipts from anon, authenticated;
