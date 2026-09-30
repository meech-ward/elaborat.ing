SET local check_function_bodies = off;

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
    select s.file_id into found_file from public.event_subscriptions s
    where s.id = prepare_event_subscription.subscription_id
      and s.user_id = prepare_event_subscription.user_id
      and s.client_id = prepare_event_subscription.client_id
      and s.project_id = prepare_event_subscription.project_id;
    if found_file is null then
      select f.id into found_file from public.project_files f
      where f.project_id = prepare_event_subscription.project_id and f.path = prepare_event_subscription.path;
    end if;
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

CREATE OR REPLACE FUNCTION private.queue_ask_agent_events()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  latest uuid;
begin
  if old.ask_agent_revision is not null or new.ask_agent_revision is null
    or new.created_by is null or new.resolved_at is not null then
    return null;
  end if;
  select c.id into latest from public.comments c
  where c.thread_id = new.id
    and c.author_id = new.created_by
    and c.agent_client_id is null
    and c.body is not null
  order by c.created_at desc, c.id desc
  limit 1;
  if latest is not null then
    perform private.queue_comment_event(new.created_by, new.project_id, new.file_id, latest);
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION private.queue_comment_event (
  author_id  uuid,
  project_id uuid,
  file_id    uuid,
  comment_id uuid
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  subscription record;
  queued boolean := false;
begin
  for subscription in
    select s.id from public.event_subscriptions s
    where s.user_id = queue_comment_event.author_id
      and s.project_id = queue_comment_event.project_id
      and s.event = 'comment.created'
      and (s.file_id is null or s.file_id = queue_comment_event.file_id)
      and s.expires_at > now()
      and s.delivery_failed_at is null
  loop
    perform pgmq.send('comment_events', jsonb_build_object(
      'subscriptionId', subscription.id,
      'commentId', queue_comment_event.comment_id,
      'eventId', 'evt_' || replace(gen_random_uuid()::text, '-', '')
    ));
    queued := true;
  end loop;
  if queued then
    perform private.wake_event_sender();
  end if;
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
begin
  if new.agent_client_id is not null or new.author_id is null or new.body is null then
    return null;
  end if;
  select * into t from public.comment_threads ct where ct.id = new.thread_id;
  if t.id is null or t.created_by is distinct from new.author_id
    or t.ask_agent_revision is null or t.resolved_at is not null then
    return null;
  end if;
  perform private.queue_comment_event(new.author_id, new.project_id, t.file_id, new.id);
  return null;
end;
$function$;

CREATE TRIGGER queue_ask_agent_events
  AFTER UPDATE OF ask_agent_revision ON public.comment_threads
  FOR EACH ROW
  EXECUTE FUNCTION private.queue_ask_agent_events();

REVOKE ALL ON FUNCTION "private"."queue_ask_agent_events"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."queue_ask_agent_events"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."queue_comment_event"(uuid, uuid, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."queue_comment_event"(uuid, uuid, uuid, uuid) TO "postgres";
