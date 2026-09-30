SET local check_function_bodies = off;

CREATE TABLE "public"."event_subscriptions" (
  "id"                    text                     NOT NULL,
  "user_id"               uuid                     NOT NULL,
  "client_id"             text                     NOT NULL,
  "event"                 text                     NOT NULL,
  "arguments"             jsonb                    NOT NULL,
  "project_id"            uuid                     NOT NULL,
  "file_id"               uuid,
  "callback_url"          text                     NOT NULL,
  "secret_id"             uuid                     NOT NULL,
  "previous_secret_id"    uuid,
  "previous_secret_until" timestamp with time zone,
  "verified_at"           timestamp with time zone NOT NULL,
  "expires_at"            timestamp with time zone NOT NULL,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "refreshed_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "delivery_failed_at"    timestamp with time zone,
  CONSTRAINT "event_subscriptions_arguments_object" CHECK ((jsonb_typeof(arguments) = 'object'::text)),
  CONSTRAINT "event_subscriptions_callback_https" CHECK (((callback_url ~ '^https://'::text) AND (char_length(callback_url) <= 2048))),
  CONSTRAINT "event_subscriptions_client_id_length" CHECK (((char_length(client_id) >= 1) AND (char_length(client_id) <= 255))),
  CONSTRAINT "event_subscriptions_event_known" CHECK ((event = 'comment.created'::text)),
  CONSTRAINT "event_subscriptions_id_format" CHECK ((id ~ '^sub_[A-Za-z0-9_-]{24}$'::text)),
  CONSTRAINT "event_subscriptions_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."event_subscriptions"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."event_subscriptions" FROM "anon", "authenticated";

CREATE OR REPLACE FUNCTION private.agent_connected (
  user_id   uuid,
  client_id text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if agent_connected.client_id is null
    or agent_connected.client_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1 from auth.oauth_consents c
    join auth.oauth_clients k on k.id = c.client_id
    where c.user_id = agent_connected.user_id
      and c.client_id = agent_connected.client_id::uuid
      and c.revoked_at is null
      and k.deleted_at is null
  );
exception when undefined_table or undefined_column or insufficient_privilege then
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION private.comment_event_delivery (
  subscription_id text,
  comment_id      uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  s public.event_subscriptions;
  c public.comments;
  t public.comment_threads;
  secrets jsonb;
  file_path text;
begin
  select * into s from public.event_subscriptions o where o.id = comment_event_delivery.subscription_id;
  if s.id is null then
    return jsonb_build_object('deliver', false, 'reason', 'no_subscription');
  end if;
  if s.expires_at <= now() then
    return jsonb_build_object('deliver', false, 'reason', 'expired');
  end if;
  if s.delivery_failed_at is not null then
    return jsonb_build_object('deliver', false, 'reason', 'delivery_failed');
  end if;
  if not private.agent_connected(s.user_id, s.client_id) then
    delete from public.event_subscriptions o where o.id = s.id;
    return jsonb_build_object('deliver', false, 'reason', 'agent_disconnected');
  end if;
  if not private.person_can_read_project(s.user_id, s.project_id) then
    delete from public.event_subscriptions o where o.id = s.id;
    return jsonb_build_object('deliver', false, 'reason', 'no_access');
  end if;

  select * into c from public.comments cm where cm.id = comment_event_delivery.comment_id;
  select * into t from public.comment_threads ct where ct.id = c.thread_id;
  if c.id is null or t.id is null or c.deleted_at is not null or c.project_id <> s.project_id
    or c.agent_client_id is not null or c.author_id is distinct from s.user_id
    or t.created_by is distinct from s.user_id or t.ask_agent_revision is null or t.resolved_at is not null then
    return jsonb_build_object('deliver', false, 'reason', 'not_asked');
  end if;
  if s.file_id is not null and t.file_id <> s.file_id then
    return jsonb_build_object('deliver', false, 'reason', 'other_file');
  end if;

  select jsonb_agg(d.decrypted_secret order by d.id = s.secret_id desc) into secrets
  from vault.decrypted_secrets d
  where d.id = s.secret_id or (d.id = s.previous_secret_id and s.previous_secret_until > now());
  if secrets is null then
    return jsonb_build_object('deliver', false, 'reason', 'no_secret');
  end if;
  file_path := coalesce(
    (select f.path from public.project_files f where f.id = t.file_id and f.project_id = t.project_id),
    (select v.path from public.file_versions v
     where v.file_id = t.file_id and v.project_id = t.project_id
     order by v.version desc limit 1),
    ''
  );
  return jsonb_build_object(
    'deliver', true,
    'url', s.callback_url,
    'secrets', secrets,
    'timestamp', c.created_at,
    'data', jsonb_build_object(
      'project_id', s.project_id,
      'path', file_path,
      'thread_id', t.id,
      'comment_id', c.id,
      'quote', left(coalesce(t.anchor -> 'quote' ->> 'exact', t.anchor ->> 'label', ''), 200),
      'text', left(c.body, 500)
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.delete_event_subscription (
  user_id         uuid,
  subscription_id text
)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  delete from public.event_subscriptions s
  where s.id = delete_event_subscription.subscription_id and s.user_id = delete_event_subscription.user_id
$function$;

CREATE OR REPLACE FUNCTION private.forget_event_subscription_secrets()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  delete from vault.secrets s where s.id in (old.secret_id, old.previous_secret_id);
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION private.person_can_read_project (
  user_id    uuid,
  project_id uuid
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select exists (
    select 1 from public.projects p
    where p.id = person_can_read_project.project_id and p.owner_id = person_can_read_project.user_id
  ) or exists (
    select 1 from public.project_members m
    where m.project_id = person_can_read_project.project_id
      and m.user_id = person_can_read_project.user_id
      and m.accepted_at is not null
  )
$function$;

CREATE OR REPLACE FUNCTION private.prepare_event_subscription (
  user_id         uuid,
  client_id       text,
  subscription_id text,
  project_id      uuid,
  path            text,
  callback_url    text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  found_file uuid;
begin
  if prepare_event_subscription.user_id is null or prepare_event_subscription.client_id is null
    or prepare_event_subscription.subscription_id is null or prepare_event_subscription.project_id is null
    or prepare_event_subscription.callback_url is null then
    raise exception 'A person, agent, subscription, project and callback are required' using errcode = '22023';
  end if;
  if not private.person_can_read_project(prepare_event_subscription.user_id, prepare_event_subscription.project_id) then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  if prepare_event_subscription.path is not null then
    select f.id into found_file from public.project_files f
    where f.project_id = prepare_event_subscription.project_id and f.path = prepare_event_subscription.path;
    if found_file is null then
      raise exception 'No such file in this project' using errcode = '22023';
    end if;
  end if;
  if (select count(*) from public.event_subscriptions s
      where s.user_id = prepare_event_subscription.user_id
        and s.expires_at > now()
        and s.id <> prepare_event_subscription.subscription_id) >= 20 then
    raise exception 'A person can have at most 20 event subscriptions' using errcode = '54000';
  end if;
  return jsonb_build_object(
    'file_id', found_file,
    'verified', exists (
      select 1 from public.event_subscriptions s
      where s.user_id = prepare_event_subscription.user_id
        and s.client_id = prepare_event_subscription.client_id
        and s.callback_url = prepare_event_subscription.callback_url
        and s.delivery_failed_at is null
        and s.verified_at > now() - interval '10 minutes'
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.queue_comment_events()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  t public.comment_threads;
  subscription record;
  queued boolean := false;
begin
  if new.agent_client_id is not null or new.author_id is null or new.body is null then
    return null;
  end if;
  select * into t from public.comment_threads ct where ct.id = new.thread_id;
  if t.id is null or t.created_by is distinct from new.author_id
    or t.ask_agent_revision is null or t.resolved_at is not null then
    return null;
  end if;
  for subscription in
    select s.id from public.event_subscriptions s
    where s.user_id = new.author_id
      and s.project_id = new.project_id
      and s.event = 'comment.created'
      and (s.file_id is null or s.file_id = t.file_id)
      and s.expires_at > now()
      and s.delivery_failed_at is null
  loop
    perform pgmq.send('comment_events', jsonb_build_object(
      'subscriptionId', subscription.id,
      'commentId', new.id,
      'eventId', 'evt_' || replace(gen_random_uuid()::text, '-', '')
    ));
    queued := true;
  end loop;
  if queued then
    perform private.wake_event_sender();
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION private.save_event_subscription (
  user_id          uuid,
  client_id        text,
  subscription_id  text,
  project_id       uuid,
  path             text,
  callback_url     text,
  arguments        jsonb,
  secret           text,
  ttl_ms           bigint,
  freshly_verified boolean
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  prepared jsonb;
  s public.event_subscriptions;
  current_secret text;
  lifetime interval;
  verified timestamptz;
begin
  if save_event_subscription.secret is null or save_event_subscription.secret !~ '^whsec_[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'A whsec_ signing secret is required' using errcode = '22023';
  end if;
  prepared := private.prepare_event_subscription(
    save_event_subscription.user_id, save_event_subscription.client_id, save_event_subscription.subscription_id,
    save_event_subscription.project_id, save_event_subscription.path, save_event_subscription.callback_url
  );
  if coalesce(save_event_subscription.freshly_verified, false) then
    verified := now();
  elsif (prepared ->> 'verified')::boolean then
    select max(o.verified_at) into verified from public.event_subscriptions o
    where o.user_id = save_event_subscription.user_id and o.client_id = save_event_subscription.client_id
      and o.callback_url = save_event_subscription.callback_url;
  else
    raise exception 'The callback has not been verified' using errcode = '22023';
  end if;
  lifetime := case
    when save_event_subscription.ttl_ms is null then interval '7 days'
    else least(greatest(save_event_subscription.ttl_ms, 600000), 604800000) * interval '1 millisecond'
  end;

  select * into s from public.event_subscriptions o where o.id = save_event_subscription.subscription_id for update;
  if s.id is null then
    insert into public.event_subscriptions (
      id, user_id, client_id, event, arguments, project_id, file_id, callback_url, secret_id, verified_at, expires_at
    )
    values (
      save_event_subscription.subscription_id, save_event_subscription.user_id, save_event_subscription.client_id,
      'comment.created', save_event_subscription.arguments, save_event_subscription.project_id,
      (prepared ->> 'file_id')::uuid, save_event_subscription.callback_url,
      vault.create_secret(save_event_subscription.secret, null, 'MCP Events signing secret'),
      verified, now() + lifetime
    )
    returning * into s;
    return jsonb_build_object('expires_at', s.expires_at);
  end if;

  if s.user_id <> save_event_subscription.user_id or s.client_id <> save_event_subscription.client_id
    or s.callback_url <> save_event_subscription.callback_url then
    raise exception 'Subscription unavailable' using errcode = '42501';
  end if;
  select d.decrypted_secret into current_secret from vault.decrypted_secrets d where d.id = s.secret_id;
  if current_secret is distinct from save_event_subscription.secret then
    delete from vault.secrets v where v.id = s.previous_secret_id;
    update public.event_subscriptions o
    set previous_secret_id = o.secret_id,
        previous_secret_until = now() + interval '15 minutes',
        secret_id = vault.create_secret(save_event_subscription.secret, null, 'MCP Events signing secret')
    where o.id = s.id;
  end if;
  update public.event_subscriptions o
  set expires_at = now() + lifetime,
      refreshed_at = now(),
      verified_at = greatest(o.verified_at, verified),
      file_id = (prepared ->> 'file_id')::uuid,
      delivery_failed_at = null
  where o.id = s.id
  returning * into s;
  return jsonb_build_object('expires_at', s.expires_at);
end;
$function$;

CREATE OR REPLACE FUNCTION private.sweep_comment_events()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  delete from public.event_subscriptions s where s.expires_at <= now();
  if exists (select 1 from pgmq.q_comment_events q where q.vt <= clock_timestamp()) then
    perform private.wake_event_sender();
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.wake_event_sender()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  project_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  secret_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'embed_secret_key');
begin
  if project_url is null or secret_key is null then
    return;
  end if;
  perform net.http_post(
    url => project_url || '/functions/v1/send-events',
    headers => jsonb_build_object('Content-Type', 'application/json', 'apikey', secret_key),
    body => '{}'::jsonb,
    timeout_milliseconds => 60000
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_event_subscription (
  user_id         uuid,
  subscription_id text
)
  RETURNS void
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.delete_event_subscription(user_id, subscription_id)
$function$;

REVOKE ALL ON FUNCTION "public"."delete_event_subscription"(uuid, text) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.prepare_event_subscription (
  user_id         uuid,
  client_id       text,
  subscription_id text,
  project_id      uuid,
  path            text,
  callback_url    text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.prepare_event_subscription(user_id, client_id, subscription_id, project_id, path, callback_url)
$function$;

REVOKE ALL ON FUNCTION "public"."prepare_event_subscription"(uuid, text, text, uuid, text, text) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.save_event_subscription (
  user_id          uuid,
  client_id        text,
  subscription_id  text,
  project_id       uuid,
  path             text,
  callback_url     text,
  arguments        jsonb,
  secret           text,
  ttl_ms           bigint,
  freshly_verified boolean
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.save_event_subscription(
    user_id, client_id, subscription_id, project_id, path, callback_url, arguments, secret, ttl_ms, freshly_verified
  )
$function$;

REVOKE ALL ON FUNCTION "public"."save_event_subscription"(uuid, text, text, uuid, text, text, jsonb, text, bigint, boolean) FROM PUBLIC, "anon", "authenticated";

ALTER TABLE "public"."event_subscriptions"
  ADD CONSTRAINT "event_subscriptions_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."event_subscriptions"
  ADD CONSTRAINT "event_subscriptions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX event_subscriptions_expires_at_idx ON public.event_subscriptions USING btree (expires_at);

CREATE INDEX event_subscriptions_project_id_idx ON public.event_subscriptions USING btree (project_id);

CREATE INDEX event_subscriptions_user_project_idx ON public.event_subscriptions USING btree (user_id, project_id);

CREATE TRIGGER queue_comment_events
  AFTER INSERT ON public.comments
  FOR EACH ROW
  EXECUTE FUNCTION private.queue_comment_events();

CREATE TRIGGER forget_event_subscription_secrets
  AFTER DELETE ON public.event_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION private.forget_event_subscription_secrets();

CREATE POLICY "People can read their own event subscriptions" ON "public"."event_subscriptions"
  FOR SELECT
  TO "authenticated"
  USING ((user_id = ( SELECT auth.uid() AS uid)));

REVOKE ALL ON FUNCTION "private"."agent_connected"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."agent_connected"(uuid, text) TO "postgres";

REVOKE ALL ON FUNCTION "private"."comment_event_delivery"(text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."comment_event_delivery"(text, uuid) TO "postgres";

REVOKE ALL ON FUNCTION "private"."delete_event_subscription"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."delete_event_subscription"(uuid, text) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."forget_event_subscription_secrets"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."forget_event_subscription_secrets"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."person_can_read_project"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."person_can_read_project"(uuid, uuid) TO "postgres";

REVOKE ALL ON FUNCTION "private"."prepare_event_subscription"(uuid, text, text, uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."prepare_event_subscription"(uuid, text, text, uuid, text, text) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."queue_comment_events"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."queue_comment_events"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."save_event_subscription"(uuid, text, text, uuid, text, text, jsonb, text, bigint, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."save_event_subscription"(uuid, text, text, uuid, text, text, jsonb, text, bigint, boolean) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."sweep_comment_events"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."sweep_comment_events"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."wake_event_sender"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."wake_event_sender"() TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."delete_event_subscription"(uuid, text) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."prepare_event_subscription"(uuid, text, text, uuid, text, text) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."save_event_subscription"(uuid, text, text, uuid, text, text, jsonb, text, bigint, boolean) TO "postgres", "service_role";

REVOKE ALL ("arguments") ON TABLE "public"."event_subscriptions" FROM "authenticated";

GRANT SELECT ("arguments") ON TABLE "public"."event_subscriptions" TO "authenticated";

REVOKE ALL ("client_id") ON TABLE "public"."event_subscriptions" FROM "authenticated";

GRANT SELECT ("client_id") ON TABLE "public"."event_subscriptions" TO "authenticated";

REVOKE ALL ("created_at") ON TABLE "public"."event_subscriptions" FROM "authenticated";

GRANT SELECT ("created_at") ON TABLE "public"."event_subscriptions" TO "authenticated";

REVOKE ALL ("delivery_failed_at") ON TABLE "public"."event_subscriptions" FROM "authenticated";

GRANT SELECT ("delivery_failed_at") ON TABLE "public"."event_subscriptions" TO "authenticated";

REVOKE ALL ("event") ON TABLE "public"."event_subscriptions" FROM "authenticated";

GRANT SELECT ("event") ON TABLE "public"."event_subscriptions" TO "authenticated";

REVOKE ALL ("expires_at") ON TABLE "public"."event_subscriptions" FROM "authenticated";

GRANT SELECT ("expires_at") ON TABLE "public"."event_subscriptions" TO "authenticated";

REVOKE ALL ("file_id") ON TABLE "public"."event_subscriptions" FROM "authenticated";

GRANT SELECT ("file_id") ON TABLE "public"."event_subscriptions" TO "authenticated";

REVOKE ALL ("id") ON TABLE "public"."event_subscriptions" FROM "authenticated";

GRANT SELECT ("id") ON TABLE "public"."event_subscriptions" TO "authenticated";

REVOKE ALL ("project_id") ON TABLE "public"."event_subscriptions" FROM "authenticated";

GRANT SELECT ("project_id") ON TABLE "public"."event_subscriptions" TO "authenticated";

REVOKE ALL ("refreshed_at") ON TABLE "public"."event_subscriptions" FROM "authenticated";

GRANT SELECT ("refreshed_at") ON TABLE "public"."event_subscriptions" TO "authenticated";

REVOKE ALL ("user_id") ON TABLE "public"."event_subscriptions" FROM "authenticated";

GRANT SELECT ("user_id") ON TABLE "public"."event_subscriptions" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."event_subscriptions" TO "postgres";

REVOKE ALL ON TABLE "public"."event_subscriptions" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."event_subscriptions" TO "service_role";

SELECT cron.schedule_in_database('sweep-comment-events', '* * * * *', 'select private.sweep_comment_events()', 'postgres', NULL, true);

SELECT pgmq.create('comment_events');
