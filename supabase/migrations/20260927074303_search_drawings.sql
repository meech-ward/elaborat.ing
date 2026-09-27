SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.is_searchable_path (
  path text
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select path ~* '\.(md|mdx|d2|excalidraw)$'
$function$;
