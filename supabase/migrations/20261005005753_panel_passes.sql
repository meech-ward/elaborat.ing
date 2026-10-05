SET local check_function_bodies = off;

CREATE TABLE "private"."panel_passes" (
  "hash"       bytea                    NOT NULL,
  "user_id"    uuid                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "used_at"    timestamp with time zone,
  CONSTRAINT "panel_passes_hash_length" CHECK ((octet_length(hash) = 32)),
  CONSTRAINT "panel_passes_pkey" PRIMARY KEY (hash)
);

ALTER TABLE "private"."panel_passes"
  ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.mint_panel_pass()
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  pass bytea := extensions.gen_random_bytes(32);
begin
  delete from private.panel_passes p
  where p.expires_at <= now()
    or (p.user_id = uid and p.used_at is not null);

  delete from private.panel_passes p
  where p.hash in (
    select k.hash
    from private.panel_passes k
    where k.user_id = uid
    order by k.created_at desc, k.hash
    offset 9
  );

  insert into private.panel_passes (hash, user_id, expires_at)
  values (sha256(pass), uid, now() + interval '5 minutes');

  return encode(pass, 'hex');
end;
$function$;

REVOKE ALL ON FUNCTION "public"."mint_panel_pass"() FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.redeem_panel_pass (
  pass text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null or private.is_oauth_client() or redeem_panel_pass.pass is null
    or redeem_panel_pass.pass !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  update private.panel_passes p
  set used_at = now()
  where p.hash = sha256(decode(redeem_panel_pass.pass, 'hex'))
    and p.user_id = uid
    and p.used_at is null
    and p.expires_at > now();

  return found;
end;
$function$;

REVOKE ALL ON FUNCTION "public"."redeem_panel_pass"(text) FROM PUBLIC, "anon", "service_role";

ALTER TABLE "private"."panel_passes"
  ADD CONSTRAINT "panel_passes_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX panel_passes_expires_at_idx ON private.panel_passes USING btree (expires_at);

CREATE INDEX panel_passes_user_id_idx ON private.panel_passes USING btree (user_id, created_at);

GRANT EXECUTE ON FUNCTION "public"."mint_panel_pass"() TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."redeem_panel_pass"(text) TO "authenticated", "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."panel_passes" TO "postgres";
