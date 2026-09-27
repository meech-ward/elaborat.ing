-- Sharing a project by email, for the `share` Edge Function. The function
-- checks the caller owns the project as that caller, then calls these with the
-- service role, which is the only role that may execute them: people and
-- agents cannot look up accounts by email or invite on someone else's behalf.

-- Before an owner invites `email`: checks they own the project, counts the
-- invitation against their daily limit (`invitations_per_day` in limits.sql,
-- for the inviter, since the service role is nobody), and finds the account
-- that uses that email, if any. Returns the account's id (null when there is
-- none, so the caller creates one through Auth's invite), the project's title
-- and the owner's email, for the invitation email.
create function private.prepare_email_invitation(inviter_id uuid, project_id uuid, email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.projects;
  inviter_email text;
  member_id uuid;
  found_limit record;
begin
  select * into p from public.projects where id = prepare_email_invitation.project_id;
  if p.id is null or p.owner_id is distinct from prepare_email_invitation.inviter_id then
    raise exception 'Only the project owner can change sharing' using errcode = '42501';
  end if;
  if prepare_email_invitation.email is null or prepare_email_invitation.email !~ '^[^@\s]+@[^@\s]+$' then
    raise exception 'Enter an email address' using errcode = '22023';
  end if;

  select * into found_limit from private.limits() l where l.name = 'invitations_per_day';
  perform private.count_use(
    prepare_email_invitation.inviter_id, found_limit.name, found_limit.max_count,
    found_limit.window_length, found_limit.what
  );

  select u.id into member_id
  from auth.users u
  where lower(u.email) = lower(prepare_email_invitation.email)
    and u.deleted_at is null
  limit 1;
  if member_id = p.owner_id then
    raise exception 'You own this project already' using errcode = '22023';
  end if;

  select u.email::text into inviter_email from auth.users u where u.id = p.owner_id;

  return jsonb_build_object('member_id', member_id, 'title', p.title, 'inviter_email', inviter_email);
end;
$$;

revoke all on function private.prepare_email_invitation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.prepare_email_invitation(uuid, uuid, text) to service_role;

create function public.prepare_email_invitation(inviter_id uuid, project_id uuid, email text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.prepare_email_invitation(inviter_id, project_id, email)
$$;

revoke all on function public.prepare_email_invitation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.prepare_email_invitation(uuid, uuid, text) to service_role;

-- Records the invitation for an account Auth has just created for an invited
-- email, as `share_project` would for its owner. Like any invitation, it
-- grants nothing until the invited person signs in and accepts it.
create function private.record_email_invitation(inviter_id uuid, project_id uuid, member_id uuid, member_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.projects;
  changed integer;
begin
  select * into p from public.projects where id = record_email_invitation.project_id for update;
  if p.id is null or p.owner_id is distinct from record_email_invitation.inviter_id then
    raise exception 'Only the project owner can change sharing' using errcode = '42501';
  end if;
  if record_email_invitation.member_id is null or record_email_invitation.member_id = p.owner_id then
    raise exception 'Invalid member' using errcode = '22023';
  end if;
  if record_email_invitation.member_role is null
    or record_email_invitation.member_role not in ('viewer', 'commenter', 'editor') then
    raise exception 'Role must be viewer, commenter or editor' using errcode = '22023';
  end if;

  insert into public.project_members as m (project_id, user_id, role)
  values (p.id, record_email_invitation.member_id, record_email_invitation.member_role)
  on conflict on constraint project_members_pkey do update
    set role = excluded.role
    where m.role is distinct from excluded.role;
  get diagnostics changed = row_count;
  if changed > 0 then
    update public.projects set revision = revision + 1, updated_at = now() where id = p.id;
  end if;

  return jsonb_build_object(
    'project_id', p.id,
    'member_id', record_email_invitation.member_id,
    'role', record_email_invitation.member_role
  );
end;
$$;

revoke all on function private.record_email_invitation(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.record_email_invitation(uuid, uuid, uuid, text) to service_role;

create function public.record_email_invitation(inviter_id uuid, project_id uuid, member_id uuid, member_role text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.record_email_invitation(inviter_id, project_id, member_id, member_role)
$$;

revoke all on function public.record_email_invitation(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_email_invitation(uuid, uuid, uuid, text) to service_role;
