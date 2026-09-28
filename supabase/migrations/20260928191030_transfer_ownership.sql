SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.transfer_project (
  project_id   uuid,
  new_owner_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  most integer;
begin
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can transfer a project' using errcode = '42501';
  end if;
  select * into p from public.projects where id = transfer_project.project_id for update;
  if p.id is null or p.owner_id <> uid then
    raise exception 'Only the project owner can transfer it' using errcode = '42501';
  end if;
  if transfer_project.new_owner_id is null or transfer_project.new_owner_id = uid then
    raise exception 'Invalid member' using errcode = '22023';
  end if;

  delete from public.project_members m
  where m.project_id = p.id
    and m.user_id = transfer_project.new_owner_id
    and m.accepted_at is not null;
  if not found then
    raise exception 'Only a member who has accepted their invitation can become the owner' using errcode = '22023';
  end if;

  select l.max_count into most from private.limits() l where l.name = 'projects';
  if (select count(*) from public.projects o where o.owner_id = transfer_project.new_owner_id) >= most then
    raise exception 'They have reached the limit of % projects, so cannot own another.', most
      using errcode = 'PT429', detail = 'projects';
  end if;

  insert into public.project_members (project_id, user_id, role, accepted_at)
  values (p.id, uid, 'editor', now());
  update public.projects
  set owner_id = transfer_project.new_owner_id, revision = revision + 1, updated_at = now()
  where id = p.id
  returning * into p;
  return private.project_summary(p, 'editor');
end;
$function$;

CREATE OR REPLACE FUNCTION public.transfer_project (
  project_id   uuid,
  new_owner_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.transfer_project(project_id, new_owner_id)
$function$;

REVOKE ALL ON FUNCTION "public"."transfer_project"(uuid, uuid) FROM PUBLIC, "anon", "service_role";

REVOKE ALL ON FUNCTION "private"."transfer_project"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."transfer_project"(uuid, uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."transfer_project"(uuid, uuid) TO "authenticated", "postgres";
