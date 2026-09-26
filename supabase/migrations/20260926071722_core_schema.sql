SET local check_function_bodies = off;

CREATE SCHEMA "private";

CREATE TABLE "private"."save_receipts" (
  "project_id"   uuid                     NOT NULL,
  "mutation_id"  uuid                     NOT NULL,
  "user_id"      uuid                     NOT NULL,
  "payload_hash" bytea                    NOT NULL,
  "result"       jsonb                    NOT NULL,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "save_receipts_pkey" PRIMARY KEY (project_id, mutation_id)
);

ALTER TABLE "private"."save_receipts"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."file_versions" (
  "file_id"     uuid                     NOT NULL,
  "version"     bigint                   NOT NULL,
  "project_id"  uuid                     NOT NULL,
  "path"        text                     COLLATE pg_catalog."C" NOT NULL,
  "content"     text,
  "deleted"     boolean                  NOT NULL DEFAULT false,
  "author_id"   uuid,
  "mutation_id" uuid                     NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "file_versions_content_matches_deleted" CHECK ((deleted = (content IS NULL))),
  CONSTRAINT "file_versions_pkey" PRIMARY KEY (file_id, VERSION),
  CONSTRAINT "file_versions_version_positive" CHECK ((version > 0))
);

ALTER TABLE "public"."file_versions"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."file_versions" FROM "anon";

CREATE TABLE "public"."project_files" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "project_id" uuid                     NOT NULL,
  "path"       text                     COLLATE pg_catalog."C" NOT NULL,
  "content"    text                     NOT NULL,
  "version"    bigint                   NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "project_files_content_size" CHECK ((octet_length(content) <= 2097152)),
  CONSTRAINT "project_files_pkey" PRIMARY KEY (id),
  CONSTRAINT "project_files_project_path_key" UNIQUE (project_id, path),
  CONSTRAINT "project_files_version_positive" CHECK ((version > 0))
);

ALTER TABLE "public"."project_files"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."project_files" FROM "anon";

CREATE TABLE "public"."project_folders" (
  "project_id" uuid                     NOT NULL,
  "path"       text                     COLLATE pg_catalog."C" NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "project_folders_pkey" PRIMARY KEY (project_id, path)
);

ALTER TABLE "public"."project_folders"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."project_folders" FROM "anon";

CREATE TABLE "public"."project_members" (
  "project_id"  uuid                     NOT NULL,
  "user_id"     uuid                     NOT NULL,
  "role"        text                     NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "accepted_at" timestamp with time zone,
  CONSTRAINT "project_members_pkey" PRIMARY KEY (project_id, user_id),
  CONSTRAINT "project_members_role_valid" CHECK ((role = ANY (ARRAY['viewer'::text, 'commenter'::text, 'editor'::text])))
);

ALTER TABLE "public"."project_members"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."project_members" FROM "anon";

CREATE TABLE "public"."projects" (
  "id"            uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "owner_id"      uuid                     NOT NULL,
  "title"         text                     NOT NULL,
  "revision"      bigint                   NOT NULL DEFAULT 0,
  "content_bytes" bigint                   NOT NULL DEFAULT 0,
  "archived_at"   timestamp with time zone,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "projects_content_bytes_limit" CHECK (((content_bytes >= 0) AND (content_bytes <= 67108864))),
  CONSTRAINT "projects_pkey" PRIMARY KEY (id),
  CONSTRAINT "projects_revision_nonnegative" CHECK ((revision >= 0)),
  CONSTRAINT "projects_title_valid" CHECK ((((char_length(title) >= 1) AND (char_length(title) <= 160)) AND (title ~ '\S'::text)))
);

ALTER TABLE "public"."projects"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."projects" FROM "anon";

CREATE OR REPLACE FUNCTION private.accept_invitation (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  invitation public.project_members;
begin
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can accept an invitation' using errcode = '42501';
  end if;
  select * into p from public.projects where id = accept_invitation.project_id for update;
  select * into invitation from public.project_members m
  where m.project_id = accept_invitation.project_id and m.user_id = uid;
  if p.id is null or invitation.user_id is null then
    raise exception 'No invitation for this project' using errcode = '42501';
  end if;
  if invitation.accepted_at is null then
    update public.project_members m set accepted_at = now()
    where m.project_id = p.id and m.user_id = uid;
    update public.projects set revision = revision + 1, updated_at = now()
    where id = p.id
    returning * into p;
  end if;
  return private.project_summary(p, invitation.role);
end;
$function$;

CREATE OR REPLACE FUNCTION private.create_project (
  project_id uuid,
  title      text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
begin
  if create_project.project_id is null then
    raise exception 'Project id required' using errcode = '22023';
  end if;

  insert into public.projects (id, owner_id, title)
  values (create_project.project_id, uid, create_project.title)
  on conflict (id) do nothing;

  select * into p from public.projects where id = create_project.project_id;
  if p.owner_id is distinct from uid then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;

  return private.project_summary(p, 'owner');
end;
$function$;

CREATE OR REPLACE FUNCTION private.delete_project (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
begin
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can permanently delete a project; agents can archive it'
      using errcode = '42501';
  end if;
  select * into p from public.projects where id = delete_project.project_id for update;
  if p.id is null or p.owner_id <> uid then
    raise exception 'Only the project owner can permanently delete it' using errcode = '42501';
  end if;
  delete from public.projects where id = p.id;
  return jsonb_build_object('id', p.id, 'deleted', true);
end;
$function$;

CREATE OR REPLACE FUNCTION private.is_oauth_client()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select nullif((select auth.jwt()) ->> 'client_id', '') is not null
$function$;

CREATE OR REPLACE FUNCTION private.is_valid_path (
  path text
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select path is not null
    and octet_length(path) between 1 and 1024
    and path is nfc normalized
    and path !~ '(^/|/$|//|(^|/)\.|[\\:[:cntrl:]])'
$function$;

CREATE OR REPLACE FUNCTION private.leave_project (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
begin
  select * into p from public.projects where id = leave_project.project_id for update;
  delete from public.project_members m
  where m.project_id = leave_project.project_id and m.user_id = uid;
  if not found then
    raise exception 'You are not a member of this project' using errcode = '42501';
  end if;
  update public.projects set revision = revision + 1, updated_at = now() where id = p.id;
  return jsonb_build_object('project_id', p.id, 'left', true);
end;
$function$;

CREATE OR REPLACE FUNCTION private.list_invitations()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'project_id', p.id,
        'title', p.title,
        'role', m.role,
        'invited_at', m.created_at
      )
      order by m.created_at desc
    ),
    '[]'::jsonb
  )
  from public.project_members m
  join public.projects p on p.id = m.project_id
  where m.user_id = (select auth.uid())
    and m.accepted_at is null
$function$;

CREATE OR REPLACE FUNCTION private.lock_project_for_edit (
  project_id     uuid,
  allow_archived boolean DEFAULT false
)
  RETURNS public.projects
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  p public.projects;
  caller_role text;
begin
  perform private.require_user();
  select * into p from public.projects where id = lock_project_for_edit.project_id for update;
  caller_role := private.project_role(lock_project_for_edit.project_id);
  if p.id is null or caller_role is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  if caller_role not in ('owner', 'editor') then
    raise exception 'Changing this project needs editor access' using errcode = '42501';
  end if;
  if p.archived_at is not null and not lock_project_for_edit.allow_archived then
    raise exception 'Project is archived' using errcode = '55000';
  end if;
  return p;
end;
$function$;

CREATE OR REPLACE FUNCTION private.path_ancestors (
  path text
)
  RETURNS text[]
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select coalesce(array_agg(array_to_string(parts[1:i], '/') order by i), '{}')
  from (select string_to_array(path, '/') as parts) s,
    generate_series(1, cardinality(s.parts) - 1) as i
$function$;

CREATE OR REPLACE FUNCTION private.project_role (
  project_id uuid
)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION private.project_summary (
  p           public.projects,
  caller_role text
)
  RETURNS jsonb
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'id', p.id,
    'title', p.title,
    'revision', p.revision,
    'archived_at', p.archived_at,
    'updated_at', p.updated_at,
    'role', caller_role
  )
$function$;

CREATE OR REPLACE FUNCTION private.readable_project_ids()
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select p.id
  from public.projects p
  where p.owner_id = (select auth.uid())
  union
  select m.project_id
  from public.project_members m
  where m.user_id = (select auth.uid())
    and m.accepted_at is not null
$function$;

CREATE OR REPLACE FUNCTION private.rename_project (
  project_id uuid,
  title      text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  p public.projects := private.lock_project_for_edit(rename_project.project_id);
begin
  update public.projects
  set title = rename_project.title, revision = revision + 1, updated_at = now()
  where id = p.id
  returning * into p;
  return private.project_summary(p, private.project_role(p.id));
end;
$function$;

CREATE OR REPLACE FUNCTION private.require_user()
  RETURNS uuid
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  return uid;
end;
$function$;

CREATE OR REPLACE FUNCTION private.save_files (
  project_id  uuid,
  mutation_id uuid,
  changes     jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  existing_receipt private.save_receipts;
  change_hash bytea;
  change jsonb;
  op text;
  change_path text;
  target_path text;
  base_version bigint;
  current_file public.project_files;
  saved_file public.project_files;
  old_bytes bigint;
  byte_delta bigint := 0;
  touched text[] := '{}';
  added_file_paths text[] := '{}';
  added_paths text[] := '{}';
  collision text;
  conflict_list jsonb[] := '{}';
  applied jsonb[] := '{}';
  new_revision bigint;
  result jsonb;
begin
  if save_files.project_id is null or save_files.mutation_id is null then
    raise exception 'Project id and mutation id are required' using errcode = '22023';
  end if;
  if jsonb_typeof(save_files.changes) is distinct from 'array'
    or jsonb_array_length(save_files.changes) not between 1 and 4096 then
    raise exception 'Changes must be a list of 1 to 4096 items' using errcode = '22023';
  end if;

  -- Archived projects still answer retries of saves that already happened.
  p := private.lock_project_for_edit(save_files.project_id, true);

  change_hash := sha256(convert_to(save_files.changes::text, 'UTF8'));
  select * into existing_receipt
  from private.save_receipts r
  where r.project_id = p.id and r.mutation_id = save_files.mutation_id;
  if existing_receipt.mutation_id is not null then
    if existing_receipt.user_id <> uid or existing_receipt.payload_hash <> change_hash then
      raise exception 'This mutation id was already used for a different save' using errcode = '22023';
    end if;
    return existing_receipt.result;
  end if;

  if p.archived_at is not null then
    raise exception 'Project is archived' using errcode = '55000';
  end if;

  new_revision := p.revision + 1;

  -- Validate every change and check versions before writing anything.
  for change in select value from jsonb_array_elements(save_files.changes) loop
    if jsonb_typeof(change) is distinct from 'object' then
      raise exception 'Each change must be an object' using errcode = '22023';
    end if;
    op := change ->> 'op';
    change_path := change ->> 'path';
    base_version := null;
    if op is null or op not in ('put', 'delete', 'move', 'mkdir', 'rmdir') then
      raise exception 'Unknown change op: %', left(coalesce(op, '(missing)'), 50) using errcode = '22023';
    end if;
    if not private.is_valid_path(change_path) then
      raise exception 'Invalid path: %', left(coalesce(change_path, '(missing)'), 200) using errcode = '22023';
    end if;
    if change_path = any (touched) then
      raise exception 'A save can change each path only once: %', change_path using errcode = '22023';
    end if;
    touched := touched || change_path;

    if op in ('put', 'delete', 'move') and coalesce(jsonb_typeof(change -> 'base_version'), 'null') <> 'null' then
      if jsonb_typeof(change -> 'base_version') <> 'number'
        or (change ->> 'base_version') !~ '^[1-9][0-9]{0,17}$' then
        raise exception 'base_version must be a positive whole number' using errcode = '22023';
      end if;
      base_version := (change ->> 'base_version')::bigint;
    end if;
    if op in ('delete', 'move') and base_version is null then
      raise exception '% needs base_version: %', op, change_path using errcode = '22023';
    end if;
    if op = 'put' and jsonb_typeof(change -> 'content') is distinct from 'string' then
      raise exception 'put needs string content: %', change_path using errcode = '22023';
    end if;

    if op in ('put', 'delete', 'move') then
      select * into current_file
      from public.project_files f
      where f.project_id = p.id and f.path = change_path;
      if (base_version is null and current_file.id is not null)
        or (base_version is not null and current_file.version is distinct from base_version) then
        conflict_list := conflict_list || jsonb_build_object(
          'path', change_path,
          'base_version', base_version,
          'current', case when current_file.id is null then null else jsonb_build_object(
            'id', current_file.id, 'version', current_file.version, 'content', current_file.content) end
        );
      end if;
    end if;

    if op = 'move' then
      target_path := change ->> 'to';
      if not private.is_valid_path(target_path) then
        raise exception 'Invalid path: %', left(coalesce(target_path, '(missing)'), 200) using errcode = '22023';
      end if;
      if target_path = any (touched) then
        raise exception 'A save can change each path only once: %', target_path using errcode = '22023';
      end if;
      touched := touched || target_path;
      select * into current_file
      from public.project_files f
      where f.project_id = p.id and f.path = target_path;
      if current_file.id is not null then
        conflict_list := conflict_list || jsonb_build_object(
          'path', target_path,
          'base_version', null,
          'current', jsonb_build_object(
            'id', current_file.id, 'version', current_file.version, 'content', current_file.content)
        );
      end if;
    end if;
  end loop;

  if cardinality(conflict_list) > 0 then
    return jsonb_build_object(
      'status', 'conflict',
      'project', jsonb_build_object('id', p.id, 'revision', p.revision),
      'conflicts', to_jsonb(conflict_list)
    );
  end if;

  -- Apply. Every changed file takes the new revision as its version.
  for change in select value from jsonb_array_elements(save_files.changes) loop
    op := change ->> 'op';
    change_path := change ->> 'path';

    if op = 'put' then
      select octet_length(f.content) into old_bytes
      from public.project_files f
      where f.project_id = p.id and f.path = change_path;
      insert into public.project_files as f (project_id, path, content, version, updated_by)
      values (p.id, change_path, change ->> 'content', new_revision, uid)
      on conflict on constraint project_files_project_path_key do update
        set content = excluded.content,
            version = excluded.version,
            updated_by = excluded.updated_by,
            updated_at = now()
      returning * into saved_file;
      byte_delta := byte_delta + octet_length(saved_file.content) - coalesce(old_bytes, 0);
      if old_bytes is null then
        added_file_paths := added_file_paths || change_path;
        added_paths := added_paths || change_path;
      end if;
      insert into public.file_versions (file_id, version, project_id, path, content, author_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, saved_file.content, uid, save_files.mutation_id);
      applied := applied || jsonb_build_object(
        'op', op, 'path', change_path, 'id', saved_file.id, 'version', new_revision);

    elsif op = 'delete' then
      delete from public.project_files f
      where f.project_id = p.id and f.path = change_path
      returning * into saved_file;
      byte_delta := byte_delta - octet_length(saved_file.content);
      insert into public.file_versions (file_id, version, project_id, path, content, deleted, author_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, null, true, uid, save_files.mutation_id);
      applied := applied || jsonb_build_object(
        'op', op, 'path', change_path, 'id', saved_file.id, 'version', new_revision);

    elsif op = 'move' then
      target_path := change ->> 'to';
      update public.project_files f
      set path = target_path, version = new_revision, updated_by = uid, updated_at = now()
      where f.project_id = p.id and f.path = change_path
      returning * into saved_file;
      added_file_paths := added_file_paths || target_path;
      added_paths := added_paths || target_path;
      insert into public.file_versions (file_id, version, project_id, path, content, author_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, saved_file.content, uid, save_files.mutation_id);
      applied := applied || jsonb_build_object(
        'op', op, 'path', change_path, 'to', target_path, 'id', saved_file.id, 'version', new_revision);

    elsif op = 'mkdir' then
      insert into public.project_folders (project_id, path)
      values (p.id, change_path)
      on conflict on constraint project_folders_pkey do nothing;
      added_paths := added_paths || change_path;
      applied := applied || jsonb_build_object('op', op, 'path', change_path);

    elsif op = 'rmdir' then
      -- Removes only the folder entry; files keep their paths.
      delete from public.project_folders d
      where d.project_id = p.id and d.path = change_path;
      applied := applied || jsonb_build_object('op', op, 'path', change_path);
    end if;
  end loop;

  -- A path is either a file or a folder, and a file cannot contain anything.
  select a.path into collision
  from unnest(added_paths) as a(path)
  where exists (
      -- a file sits where one of this path's folders should be
      select 1 from public.project_files f
      where f.project_id = p.id and f.path = any (private.path_ancestors(a.path))
    )
    or (
      -- a file and a folder share this path
      exists (select 1 from public.project_files f where f.project_id = p.id and f.path = a.path)
      and exists (select 1 from public.project_folders d where d.project_id = p.id and d.path = a.path)
    )
  limit 1;
  if collision is null then
    -- a new file already has files or folders below it
    select a.path into collision
    from unnest(added_file_paths) as a(path)
    where exists (
        select 1 from public.project_files f
        where f.project_id = p.id
          and f.path >= (a.path || '/') collate "C"
          and f.path < (a.path || '0') collate "C"
      )
      or exists (
        select 1 from public.project_folders d
        where d.project_id = p.id
          and d.path >= (a.path || '/') collate "C"
          and d.path < (a.path || '0') collate "C"
      )
    limit 1;
  end if;
  if collision is not null then
    raise exception 'Path is already used by a file or folder: %', collision
      using errcode = '23505', detail = collision;
  end if;

  if (select count(*) from public.project_files f where f.project_id = p.id) > 4096
    or (select count(*) from public.project_folders d where d.project_id = p.id) > 4096 then
    raise exception 'A project can hold at most 4096 files and 4096 folders' using errcode = '54000';
  end if;
  if p.content_bytes + byte_delta > 67108864 then
    raise exception 'A project can hold at most 64 MiB of files' using errcode = '54000';
  end if;

  update public.projects
  set revision = new_revision,
      content_bytes = content_bytes + byte_delta,
      updated_at = now()
  where id = p.id;

  result := jsonb_build_object(
    'status', 'saved',
    'project', jsonb_build_object('id', p.id, 'revision', new_revision),
    'changes', to_jsonb(applied)
  );

  insert into private.save_receipts (project_id, mutation_id, user_id, payload_hash, result)
  values (p.id, save_files.mutation_id, uid, change_hash, result);

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION private.set_project_archived (
  project_id uuid,
  archived   boolean
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  p public.projects := private.lock_project_for_edit(set_project_archived.project_id, true);
begin
  if (p.archived_at is not null) is distinct from set_project_archived.archived then
    update public.projects
    set archived_at = case when set_project_archived.archived then now() end,
        revision = revision + 1,
        updated_at = now()
    where id = p.id
    returning * into p;
  end if;
  return private.project_summary(p, private.project_role(p.id));
end;
$function$;

CREATE OR REPLACE FUNCTION private.share_project (
  project_id  uuid,
  member_id   uuid,
  member_role text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  changed integer;
begin
  select * into p from public.projects where id = share_project.project_id for update;
  if p.id is null or p.owner_id <> uid then
    raise exception 'Only the project owner can change sharing' using errcode = '42501';
  end if;
  if share_project.member_id is null or share_project.member_id = p.owner_id then
    raise exception 'Invalid member' using errcode = '22023';
  end if;

  if share_project.member_role is null then
    delete from public.project_members m
    where m.project_id = p.id and m.user_id = share_project.member_id;
  elsif share_project.member_role in ('viewer', 'commenter', 'editor') then
    insert into public.project_members as m (project_id, user_id, role)
    values (p.id, share_project.member_id, share_project.member_role)
    on conflict on constraint project_members_pkey do update
      set role = excluded.role
      where m.role is distinct from excluded.role;
  else
    raise exception 'Role must be viewer, commenter or editor' using errcode = '22023';
  end if;

  get diagnostics changed = row_count;
  if changed > 0 then
    update public.projects set revision = revision + 1, updated_at = now() where id = p.id;
  end if;

  return jsonb_build_object(
    'project_id', p.id,
    'member_id', share_project.member_id,
    'role', share_project.member_role
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.accept_invitation (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.accept_invitation(project_id)
$function$;

REVOKE ALL ON FUNCTION "public"."accept_invitation"(uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.archive_project (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.set_project_archived(project_id, true)
$function$;

REVOKE ALL ON FUNCTION "public"."archive_project"(uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.create_project (
  project_id uuid,
  title      text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.create_project(project_id, title)
$function$;

REVOKE ALL ON FUNCTION "public"."create_project"(uuid, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.delete_project (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.delete_project(project_id)
$function$;

REVOKE ALL ON FUNCTION "public"."delete_project"(uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.leave_project (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.leave_project(project_id)
$function$;

REVOKE ALL ON FUNCTION "public"."leave_project"(uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.list_invitations()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.list_invitations()
$function$;

REVOKE ALL ON FUNCTION "public"."list_invitations"() FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.list_projects()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(
    jsonb_agg(private.project_summary(p, private.project_role(p.id)) order by p.updated_at desc),
    '[]'::jsonb
  )
  from public.projects p
$function$;

REVOKE ALL ON FUNCTION "public"."list_projects"() FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.read_project (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.project_summary(p, private.project_role(p.id)) || jsonb_build_object(
    'folders', coalesce(
      (select jsonb_agg(d.path order by d.path) from public.project_folders d where d.project_id = p.id),
      '[]'::jsonb
    ),
    'files', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', f.id,
            'path', f.path,
            'content', f.content,
            'version', f.version,
            'updated_at', f.updated_at
          )
          order by f.path
        )
        from public.project_files f
        where f.project_id = p.id
      ),
      '[]'::jsonb
    )
  )
  from public.projects p
  where p.id = read_project.project_id
$function$;

REVOKE ALL ON FUNCTION "public"."read_project"(uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.rename_project (
  project_id uuid,
  title      text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.rename_project(project_id, title)
$function$;

REVOKE ALL ON FUNCTION "public"."rename_project"(uuid, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.save_files (
  project_id  uuid,
  mutation_id uuid,
  changes     jsonb
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.save_files(project_id, mutation_id, changes)
$function$;

REVOKE ALL ON FUNCTION "public"."save_files"(uuid, uuid, jsonb) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.share_project (
  project_id  uuid,
  member_id   uuid,
  member_role text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.share_project(project_id, member_id, member_role)
$function$;

REVOKE ALL ON FUNCTION "public"."share_project"(uuid, uuid, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.unarchive_project (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.set_project_archived(project_id, false)
$function$;

REVOKE ALL ON FUNCTION "public"."unarchive_project"(uuid) FROM PUBLIC, "anon", "service_role";

ALTER TABLE "private"."save_receipts"
  ADD CONSTRAINT "save_receipts_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."file_versions"
  ADD CONSTRAINT "file_versions_author_id_fkey" FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."project_files"
  ADD CONSTRAINT "project_files_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."project_members"
  ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."projects"
  ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "private"."save_receipts"
  ADD CONSTRAINT "save_receipts_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."file_versions"
  ADD CONSTRAINT "file_versions_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."project_files"
  ADD CONSTRAINT "project_files_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."project_folders"
  ADD CONSTRAINT "project_folders_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."project_members"
  ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

CREATE INDEX save_receipts_user_id_idx ON private.save_receipts USING btree (user_id);

CREATE INDEX file_versions_author_id_idx ON public.file_versions USING btree (author_id);

CREATE INDEX file_versions_project_id_idx ON public.file_versions USING btree (project_id);

CREATE INDEX project_files_updated_by_idx ON public.project_files USING btree (updated_by);

CREATE INDEX project_members_user_id_idx ON public.project_members USING btree (user_id);

CREATE INDEX projects_owner_id_idx ON public.projects USING btree (owner_id);

CREATE POLICY "People can read file history in their projects" ON "public"."file_versions"
  FOR SELECT
  TO "authenticated"
  USING ((project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids)));

CREATE POLICY "People can read files in their projects" ON "public"."project_files"
  FOR SELECT
  TO "authenticated"
  USING ((project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids)));

CREATE POLICY "People can read folders in their projects" ON "public"."project_folders"
  FOR SELECT
  TO "authenticated"
  USING ((project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids)));

CREATE POLICY "People can see members of their projects and their own invites" ON "public"."project_members"
  FOR SELECT
  TO "authenticated"
  USING (((user_id = ( SELECT auth.uid() AS uid)) OR (project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids))));

CREATE POLICY "People can read projects they own or have joined" ON "public"."projects"
  FOR SELECT
  TO "authenticated"
  USING ((id IN ( SELECT private.readable_project_ids() AS readable_project_ids)));

REVOKE ALL ON FUNCTION "private"."accept_invitation"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."accept_invitation"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."create_project"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."create_project"(uuid, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."delete_project"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."delete_project"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."is_oauth_client"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."is_oauth_client"() TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."is_valid_path"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."is_valid_path"(text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."leave_project"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."leave_project"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."list_invitations"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."list_invitations"() TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."lock_project_for_edit"(uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."lock_project_for_edit"(uuid, boolean) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."path_ancestors"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."path_ancestors"(text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."project_role"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."project_role"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."project_summary"(public.projects, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."project_summary"(public.projects, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."readable_project_ids"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."readable_project_ids"() TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."rename_project"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."rename_project"(uuid, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."require_user"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."require_user"() TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."save_files"(uuid, uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."save_files"(uuid, uuid, jsonb) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."set_project_archived"(uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."set_project_archived"(uuid, boolean) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."share_project"(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."share_project"(uuid, uuid, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."accept_invitation"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."archive_project"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."create_project"(uuid, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."delete_project"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."leave_project"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."list_invitations"() TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."list_projects"() TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."read_project"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."rename_project"(uuid, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."save_files"(uuid, uuid, jsonb) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."share_project"(uuid, uuid, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."unarchive_project"(uuid) TO "authenticated", "postgres";

GRANT USAGE ON SCHEMA "private" TO "authenticated";

GRANT CREATE, USAGE ON SCHEMA "private" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."save_receipts" TO "postgres";

REVOKE ALL ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ON TABLE "public"."file_versions" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."file_versions" TO "postgres";

REVOKE ALL ON TABLE "public"."file_versions" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."file_versions" TO "service_role";

REVOKE ALL ON TABLE "public"."project_files" FROM "authenticated";

GRANT SELECT ON TABLE "public"."project_files" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."project_files" TO "postgres";

REVOKE ALL ON TABLE "public"."project_files" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."project_files" TO "service_role";

REVOKE ALL ON TABLE "public"."project_folders" FROM "authenticated";

GRANT SELECT ON TABLE "public"."project_folders" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."project_folders" TO "postgres";

REVOKE ALL ON TABLE "public"."project_folders" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."project_folders" TO "service_role";

REVOKE ALL ON TABLE "public"."project_members" FROM "authenticated";

GRANT SELECT ON TABLE "public"."project_members" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."project_members" TO "postgres";

REVOKE ALL ON TABLE "public"."project_members" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."project_members" TO "service_role";

REVOKE ALL ON TABLE "public"."projects" FROM "authenticated";

GRANT SELECT ON TABLE "public"."projects" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."projects" TO "postgres";

REVOKE ALL ON TABLE "public"."projects" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."projects" TO "service_role";

ALTER TABLE "public"."project_files"
  ADD CONSTRAINT "project_files_path_valid" CHECK (private.is_valid_path(path));

ALTER TABLE "public"."project_folders"
  ADD CONSTRAINT "project_folders_path_valid" CHECK (private.is_valid_path(path));
