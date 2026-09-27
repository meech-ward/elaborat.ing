SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.limits()
  RETURNS TABLE (
    name          text,
    max_count     integer,
    window_length interval,
    what          text
  )
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  values
    ('projects_per_day', 100, interval '1 day', 'new projects a day'),
    ('projects', 1000, null, 'projects'),
    ('saves_per_minute', 300, interval '1 minute', 'saves a minute'),
    ('searches_per_minute', 120, interval '1 minute', 'searches a minute'),
    ('tool_calls_per_minute', 300, interval '1 minute', 'agent tool calls a minute'),
    ('invitations_per_day', 50, interval '1 day', 'invitations a day')
$function$;

CREATE OR REPLACE FUNCTION private.prepare_email_invitation (
  inviter_id uuid,
  project_id uuid,
  email      text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION private.record_email_invitation (
  inviter_id  uuid,
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
$function$;

CREATE OR REPLACE FUNCTION public.prepare_email_invitation (
  inviter_id uuid,
  project_id uuid,
  email      text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.prepare_email_invitation(inviter_id, project_id, email)
$function$;

REVOKE ALL ON FUNCTION "public"."prepare_email_invitation"(uuid, uuid, text) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.record_email_invitation (
  inviter_id  uuid,
  project_id  uuid,
  member_id   uuid,
  member_role text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.record_email_invitation(inviter_id, project_id, member_id, member_role)
$function$;

REVOKE ALL ON FUNCTION "public"."record_email_invitation"(uuid, uuid, uuid, text) FROM PUBLIC, "anon", "authenticated";

REVOKE ALL ON FUNCTION "private"."prepare_email_invitation"(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."prepare_email_invitation"(uuid, uuid, text) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."record_email_invitation"(uuid, uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."record_email_invitation"(uuid, uuid, uuid, text) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."prepare_email_invitation"(uuid, uuid, text) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."record_email_invitation"(uuid, uuid, uuid, text) TO "postgres", "service_role";

REVOKE ALL ON SCHEMA "private" FROM "service_role";

GRANT USAGE ON SCHEMA "private" TO "service_role";
