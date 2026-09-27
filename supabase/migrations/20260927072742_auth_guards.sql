SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.refuse_agent_password_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if exists (
    select 1 from auth.sessions s
    where s.user_id = new.id and s.oauth_client_id is not null
  ) and not exists (
    select 1 from auth.sessions s
    where s.user_id = new.id and s.oauth_client_id is null
  ) then
    raise exception 'Agents can''t change a password' using errcode = '42501';
  end if;
  return null;
end;
$function$;

CREATE CONSTRAINT TRIGGER refuse_agent_password_change
  AFTER UPDATE OF reauthentication_token ON auth.users DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (((new.encrypted_password)::text IS DISTINCT FROM (old.encrypted_password)::text))
  EXECUTE FUNCTION private.refuse_agent_password_change();

REVOKE ALL ON FUNCTION "private"."refuse_agent_password_change"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."refuse_agent_password_change"() TO "postgres";
