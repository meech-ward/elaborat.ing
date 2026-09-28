-- Project lifecycle, sharing and reads.
--
-- Writes go through these functions only; clients have no direct insert,
-- update or delete grants. Each write is a security definer function in the
-- unexposed `private` schema that checks the caller's role itself, called from
-- a thin security invoker wrapper in `public` that the Data API exposes.

create function private.project_summary(p public.projects, caller_role text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'title', p.title,
    'revision', p.revision,
    'archived_at', p.archived_at,
    'updated_at', p.updated_at,
    'role', caller_role
  )
$$;

revoke all on function private.project_summary(public.projects, text) from public, anon;
grant execute on function private.project_summary(public.projects, text) to authenticated;

-- Create a project with a client-chosen id, so it can be created offline.
-- Repeating the call with the same id returns the existing project. If the id
-- already belongs to someone else, the call fails with 'Project unavailable':
-- the client must then give its local project a fresh id, and must never save
-- to the refused id. A new project counts against the owner's limits
-- (limits.sql); a repeated call does not.
create function private.create_project(project_id uuid, title text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  p public.projects;
  created boolean;
  most integer;
begin
  if create_project.project_id is null then
    raise exception 'Project id required' using errcode = '22023';
  end if;

  insert into public.projects (id, owner_id, title)
  values (create_project.project_id, uid, create_project.title)
  on conflict (id) do nothing;
  created := found;

  select * into p from public.projects where id = create_project.project_id;
  if p.owner_id is distinct from uid then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;

  if created then
    -- Counting first locks the owner's counter row, so two creates at once
    -- are counted one after the other and the total below sees both.
    perform private.check_limit('projects_per_day');
    select l.max_count into most from private.limits() l where l.name = 'projects';
    if (select count(*) from public.projects o where o.owner_id = uid) > most then
      raise exception 'You have reached the limit of % projects. Permanently delete one to make room.', most
        using errcode = 'PT429', detail = 'projects';
    end if;
  end if;

  return private.project_summary(p, 'owner');
end;
$$;

revoke all on function private.create_project(uuid, text) from public, anon;
grant execute on function private.create_project(uuid, text) to authenticated;

create function public.create_project(project_id uuid, title text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.create_project(project_id, title)
$$;

revoke all on function public.create_project(uuid, text) from public, anon;
grant execute on function public.create_project(uuid, text) to authenticated;

-- Lock a project for a write by an owner or editor, or raise.
create function private.lock_project_for_edit(project_id uuid, allow_archived boolean default false)
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
$$;

revoke all on function private.lock_project_for_edit(uuid, boolean) from public, anon;
grant execute on function private.lock_project_for_edit(uuid, boolean) to authenticated;

create function private.rename_project(project_id uuid, title text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.projects := private.lock_project_for_edit(rename_project.project_id);
begin
  update public.projects
  set title = rename_project.title, revision = revision + 1, updated_at = now()
  where id = p.id
  returning * into p;
  return private.project_summary(p, private.project_role(p.id));
end;
$$;

revoke all on function private.rename_project(uuid, text) from public, anon;
grant execute on function private.rename_project(uuid, text) to authenticated;

create function public.rename_project(project_id uuid, title text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.rename_project(project_id, title)
$$;

revoke all on function public.rename_project(uuid, text) from public, anon;
grant execute on function public.rename_project(uuid, text) to authenticated;

-- Archive or unarchive. Any editor may do this, including agents; archiving is
-- how agents remove a project, because only people can permanently delete.
create function private.set_project_archived(project_id uuid, archived boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.set_project_archived(uuid, boolean) from public, anon;
grant execute on function private.set_project_archived(uuid, boolean) to authenticated;

create function public.archive_project(project_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.set_project_archived(project_id, true)
$$;

revoke all on function public.archive_project(uuid) from public, anon;
grant execute on function public.archive_project(uuid) to authenticated;

create function public.unarchive_project(project_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.set_project_archived(project_id, false)
$$;

revoke all on function public.unarchive_project(uuid) from public, anon;
grant execute on function public.unarchive_project(uuid) to authenticated;

-- Permanently delete a project and everything in it. Only the owner, and only
-- in a normal session: tokens issued to OAuth clients (agents) are refused.
create function private.delete_project(project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.delete_project(uuid) from public, anon;
grant execute on function private.delete_project(uuid) to authenticated;

create function public.delete_project(project_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.delete_project(project_id)
$$;

revoke all on function public.delete_project(uuid) from public, anon;
grant execute on function public.delete_project(uuid) to authenticated;

-- Invite another account to a project, change a member's role, or remove them
-- (member_role null). Owner only. A new member gets an invitation, which grants
-- nothing until they accept it themselves.
create function private.share_project(project_id uuid, member_id uuid, member_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.share_project(uuid, uuid, text) from public, anon;
grant execute on function private.share_project(uuid, uuid, text) to authenticated;

create function public.share_project(project_id uuid, member_id uuid, member_role text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.share_project(project_id, member_id, member_role)
$$;

revoke all on function public.share_project(uuid, uuid, text) from public, anon;
grant execute on function public.share_project(uuid, uuid, text) to authenticated;

-- Invitations waiting for the caller to accept, with each project's title.
create function private.list_invitations()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.list_invitations() from public, anon;
grant execute on function private.list_invitations() to authenticated;

create function public.list_invitations()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.list_invitations()
$$;

revoke all on function public.list_invitations() from public, anon;
grant execute on function public.list_invitations() to authenticated;

-- Who a project is shared with: the owner first, then accepted members, then
-- invitations still waiting, which only the owner sees. Each entry has the
-- person's id, email and name (private.person_name: the name they set or
-- their provider gave, else their email), their role, and when they were
-- invited and accepted (both null for the owner). The owner and accepted
-- members may ask; anyone else, including a person whose invitation is still
-- pending, is refused as for a project they cannot see.
create function private.list_members(project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_role text;
begin
  perform private.require_user();
  caller_role := private.project_role(list_members.project_id);
  if caller_role is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  return (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'user_id', x.user_id,
          'email', x.email,
          'name', x.name,
          'role', x.role,
          'invited_at', x.invited_at,
          'accepted_at', x.accepted_at
        )
        order by x.rank, x.invited_at, x.email
      ),
      '[]'::jsonb
    )
    from (
      select p.owner_id as user_id, u.email::text as email,
        private.person_name(u.raw_user_meta_data, u.email::text) as name, 'owner' as role,
        null::timestamptz as invited_at, null::timestamptz as accepted_at, 0 as rank
      from public.projects p
      join auth.users u on u.id = p.owner_id
      where p.id = list_members.project_id
      union all
      select m.user_id, u.email::text, private.person_name(u.raw_user_meta_data, u.email::text),
        m.role, m.created_at, m.accepted_at,
        case when m.accepted_at is null then 2 else 1 end
      from public.project_members m
      join auth.users u on u.id = m.user_id
      where m.project_id = list_members.project_id
        and (m.accepted_at is not null or caller_role = 'owner')
    ) x
  );
end;
$$;

revoke all on function private.list_members(uuid) from public, anon;
grant execute on function private.list_members(uuid) to authenticated;

create function public.list_members(project_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.list_members(project_id)
$$;

revoke all on function public.list_members(uuid) from public, anon;
grant execute on function public.list_members(uuid) to authenticated;

-- Accept an invitation. Only a signed-in person can accept: an agent must not
-- be able to join its user to a project someone else controls.
create function private.accept_invitation(project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.accept_invitation(uuid) from public, anon;
grant execute on function private.accept_invitation(uuid) to authenticated;

create function public.accept_invitation(project_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.accept_invitation(project_id)
$$;

revoke all on function public.accept_invitation(uuid) from public, anon;
grant execute on function public.accept_invitation(uuid) to authenticated;

-- Leave a project, or decline an invitation. Anyone can do this for themselves,
-- including agents. Owners cannot leave their own project.
create function private.leave_project(project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.leave_project(uuid) from public, anon;
grant execute on function private.leave_project(uuid) to authenticated;

create function public.leave_project(project_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.leave_project(project_id)
$$;

revoke all on function public.leave_project(uuid) from public, anon;
grant execute on function public.leave_project(uuid) to authenticated;

-- Every project the caller can read, newest first. Runs as the caller, so RLS
-- decides what is visible.
create function public.list_projects()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(private.project_summary(p, private.project_role(p.id)) order by p.updated_at desc),
    '[]'::jsonb
  )
  from public.projects p
$$;

revoke all on function public.list_projects() from public, anon;
grant execute on function public.list_projects() to authenticated;

-- One project with all its files and folders, read in a single consistent
-- snapshot. Null when the caller cannot read it.
create function public.read_project(project_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
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
$$;

revoke all on function public.read_project(uuid) from public, anon;
grant execute on function public.read_project(uuid) to authenticated;
