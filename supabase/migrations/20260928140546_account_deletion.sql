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
    ('invitations_per_day', 50, interval '1 day', 'invitations a day'),
    ('comment_writes_per_minute', 120, interval '1 minute', 'comment changes a minute'),
    ('account_deletions_per_day', 5, interval '1 day', 'account deletion attempts a day')
$function$;

CREATE OR REPLACE FUNCTION public.account_deletion_summary()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'owned', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'title', p.title,
            'archived', p.archived_at is not null,
            'members', (
              select count(*)
              from public.project_members m
              where m.project_id = p.id and m.accepted_at is not null
            )
          )
          order by lower(p.title), p.id
        )
        from public.projects p
        where p.owner_id = private.require_user()
      ),
      '[]'::jsonb
    ),
    'shared', (
      select count(*)
      from public.project_members m
      where m.user_id = private.require_user() and m.accepted_at is not null
    )
  )
$function$;

REVOKE ALL ON FUNCTION "public"."account_deletion_summary"() FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.begin_account_deletion()
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  perform private.require_user();
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can delete their account' using errcode = '42501';
  end if;
  perform private.check_limit('account_deletions_per_day');
  return public.account_deletion_summary();
end;
$function$;

REVOKE ALL ON FUNCTION "public"."begin_account_deletion"() FROM PUBLIC, "anon", "service_role";

GRANT EXECUTE ON FUNCTION "public"."account_deletion_summary"() TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."begin_account_deletion"() TO "authenticated", "postgres";
