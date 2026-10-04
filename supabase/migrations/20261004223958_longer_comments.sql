SET local check_function_bodies = off;

ALTER TABLE "public"."comments"
  DROP CONSTRAINT "comments_body_valid";

CREATE OR REPLACE FUNCTION private.check_comment_body (
  body text
)
  RETURNS void
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
begin
  if check_comment_body.body is null or char_length(check_comment_body.body) < 1
    or char_length(check_comment_body.body) > 100000 or check_comment_body.body !~ '\S' then
    raise exception 'A comment is 1 to 100000 characters' using errcode = '22023';
  end if;
end;
$function$;

ALTER TABLE "public"."comments"
  ADD CONSTRAINT "comments_body_valid" CHECK (((body IS NULL) OR ((char_length(body) >= 1) AND (char_length(body) <= 100000) AND (body ~ '\S'::text))));
