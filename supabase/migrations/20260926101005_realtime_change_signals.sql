SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.broadcast_project_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform realtime.send(
    jsonb_build_object('revision', new.revision),
    'changed',
    'project:' || new.id::text,
    true
  );
  return null;
end;
$function$;

CREATE TRIGGER broadcast_change
  AFTER UPDATE OF revision ON public.projects
  FOR EACH ROW
  WHEN ((new.revision IS DISTINCT FROM old.revision))
  EXECUTE FUNCTION private.broadcast_project_change();

CREATE POLICY "People can receive change signals for projects they can read" ON "realtime"."messages"
  FOR SELECT
  TO "authenticated"
  USING (((EXTENSION = 'broadcast'::text) AND (( SELECT realtime.topic() AS topic) IN ( SELECT ('project:'::text || (readable.id)::text)
   FROM private.readable_project_ids() readable(id)))));

REVOKE ALL ON FUNCTION "private"."broadcast_project_change"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."broadcast_project_change"() TO "postgres";
