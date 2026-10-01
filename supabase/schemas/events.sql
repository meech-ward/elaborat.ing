-- Agents watching for comments (MCP Events). See "Agents (MCP)" in
-- docs/architecture.md.
--
-- A connected agent subscribes (events/subscribe on the MCP server) to
-- comment.created in one project, or one file of it, with a callback URL and
-- a signing secret. A subscription belongs to the person and the agent (OAuth
-- client) that made it. A comment wakes only its own author's agents, and
-- only when its author asked an agent: their own new thread with Ask an agent
-- on, their own reply, as a person, on their own open thread that has it on,
-- turning it on for their own open thread, or reopening, as a person, their
-- own thread that has it on (the rule list_comments's ask_agent filter
-- follows). Comments an agent wrote never wake anything, so an agent's reply
-- cannot start a loop, and no one's comment ever reaches another person's
-- agent.
--
-- Triggers on comments and threads queue one message per matching
-- subscription in the comment_events pgmq queue and wake the send-events Edge
-- Function with pg_net. The function checks it all again when it delivers
-- (private.comment_event_delivery), signs the event and posts it. A failed
-- delivery comes back when its visibility timeout ends; a pg_cron job looks
-- once a minute and wakes the function only when one is due.
--
-- Only the service role writes subscriptions: the MCP server checks the
-- caller as the caller, verifies the callback with a signed challenge, and
-- then saves it. Signing secrets live in Vault. People and their agents read
-- their own subscriptions, without their callbacks or secrets.

create table public.event_subscriptions (
  -- Derived from the person, the agent, the callback, the event and its
  -- arguments, so subscribing again updates the same one.
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The OAuth client (agent) that subscribed.
  client_id text not null,
  event text not null,
  -- The arguments as the agent gave them: project_id, and path when it watches one file.
  arguments jsonb not null,
  project_id uuid not null references public.projects (id) on delete cascade,
  -- project_files.id of the watched file, found from its path when it
  -- subscribed, so the subscription follows a rename. Null for the whole project.
  file_id uuid,
  callback_url text not null,
  -- Vault secrets: the signing secret, and the one it replaced while that is
  -- still honoured.
  secret_id uuid not null,
  previous_secret_id uuid,
  previous_secret_until timestamptz,
  -- When the callback last answered the verification challenge.
  verified_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  refreshed_at timestamptz not null default now(),
  -- Set when a delivery was given up after its last retry; nothing more is
  -- sent until the agent subscribes again.
  delivery_failed_at timestamptz,
  constraint event_subscriptions_id_format check (id ~ '^sub_[A-Za-z0-9_-]{24}$'),
  constraint event_subscriptions_event_known check (event = 'comment.created'),
  constraint event_subscriptions_client_id_length check (char_length(client_id) between 1 and 255),
  constraint event_subscriptions_arguments_object check (jsonb_typeof(arguments) = 'object'),
  constraint event_subscriptions_callback_https check (callback_url ~ '^https://' and char_length(callback_url) <= 2048)
);

create index event_subscriptions_user_project_idx on public.event_subscriptions (user_id, project_id);
create index event_subscriptions_project_id_idx on public.event_subscriptions (project_id);
create index event_subscriptions_expires_at_idx on public.event_subscriptions (expires_at);

alter table public.event_subscriptions enable row level security;

revoke all on table public.event_subscriptions from anon, authenticated;
grant select (id, user_id, client_id, event, arguments, project_id, file_id, expires_at, created_at, refreshed_at, delivery_failed_at)
  on table public.event_subscriptions to authenticated;

create policy "People can read their own event subscriptions"
  on public.event_subscriptions
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- A subscription's secrets leave Vault with it, however it goes: unsubscribed,
-- expired, or with its person or project.
create function private.forget_event_subscription_secrets()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets s where s.id in (old.secret_id, old.previous_secret_id);
  return null;
end;
$$;

revoke all on function private.forget_event_subscription_secrets() from public, anon, authenticated;

create trigger forget_event_subscription_secrets
  after delete on public.event_subscriptions
  for each row
  execute function private.forget_event_subscription_secrets();

-- Whether this person can read this project now: its owner, or a member who
-- accepted. project_role() for someone other than the caller.
create function private.person_can_read_project(user_id uuid, project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = person_can_read_project.project_id and p.owner_id = person_can_read_project.user_id
  ) or exists (
    select 1 from public.project_members m
    where m.project_id = person_can_read_project.project_id
      and m.user_id = person_can_read_project.user_id
      and m.accepted_at is not null
  )
$$;

revoke all on function private.person_can_read_project(uuid, uuid) from public, anon, authenticated;

-- Whether the person still has this agent connected: they approved it and have
-- not revoked it in Connected agents, and it is still registered. If the
-- records cannot be read, it counts as not connected, so nothing is sent.
create function private.agent_connected(user_id uuid, client_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.agent_connected(uuid, text) from public, anon, authenticated;

-- Before a subscription's callback is verified: the person can read the
-- project, the file (when one is named) is in it, and they have room for
-- another. Returns the file's id and whether this agent verified this callback
-- in the last 10 minutes, so subscribing again does not challenge it again.
-- Raises with the reason otherwise. The path is looked up only the first time:
-- refreshing a subscription (the same id, person and agent) keeps the file it
-- found then, so the watch follows that file through a rename and never moves
-- to another file created at the old path.
create function private.prepare_event_subscription(
  user_id uuid, client_id text, subscription_id text, project_id uuid, path text, callback_url text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.prepare_event_subscription(uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function private.prepare_event_subscription(uuid, text, text, uuid, text, text) to service_role;

create function public.prepare_event_subscription(
  user_id uuid, client_id text, subscription_id text, project_id uuid, path text, callback_url text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.prepare_event_subscription(user_id, client_id, subscription_id, project_id, path, callback_url)
$$;

revoke all on function public.prepare_event_subscription(uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.prepare_event_subscription(uuid, text, text, uuid, text, text) to service_role;

-- Saves a subscription once its callback has answered the challenge
-- (`freshly_verified`), or when this agent verified the same callback in the
-- last 10 minutes. Checks everything prepare_event_subscription checks again.
-- Subscribing again with the same id refreshes it: a new expiry, deliveries
-- back on, and a new secret, if one came, with the one it replaces still
-- honoured for 15 minutes. The lifetime is what the agent asked for (ttl_ms),
-- at least 10 minutes and at most 7 days, and 7 days when it asked for none
-- or for no expiry. Returns when it expires.
create function private.save_event_subscription(
  user_id uuid, client_id text, subscription_id text, project_id uuid, path text, callback_url text,
  arguments jsonb, secret text, ttl_ms bigint, freshly_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.save_event_subscription(uuid, text, text, uuid, text, text, jsonb, text, bigint, boolean) from public, anon, authenticated;
grant execute on function private.save_event_subscription(uuid, text, text, uuid, text, text, jsonb, text, bigint, boolean) to service_role;

create function public.save_event_subscription(
  user_id uuid, client_id text, subscription_id text, project_id uuid, path text, callback_url text,
  arguments jsonb, secret text, ttl_ms bigint, freshly_verified boolean
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.save_event_subscription(
    user_id, client_id, subscription_id, project_id, path, callback_url, arguments, secret, ttl_ms, freshly_verified
  )
$$;

revoke all on function public.save_event_subscription(uuid, text, text, uuid, text, text, jsonb, text, bigint, boolean) from public, anon, authenticated;
grant execute on function public.save_event_subscription(uuid, text, text, uuid, text, text, jsonb, text, bigint, boolean) to service_role;

-- Stops a subscription of this person's. Stopping one that is not there is not an error.
create function private.delete_event_subscription(user_id uuid, subscription_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.event_subscriptions s
  where s.id = delete_event_subscription.subscription_id and s.user_id = delete_event_subscription.user_id
$$;

revoke all on function private.delete_event_subscription(uuid, text) from public, anon, authenticated;
grant execute on function private.delete_event_subscription(uuid, text) to service_role;

create function public.delete_event_subscription(user_id uuid, subscription_id text)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.delete_event_subscription(user_id, subscription_id)
$$;

revoke all on function public.delete_event_subscription(uuid, text) from public, anon, authenticated;
grant execute on function public.delete_event_subscription(uuid, text) to service_role;

-- The queue of events to deliver. pg-delta declares pgmq queues and pg_cron
-- jobs as extension intent, so these calls belong here.
select pgmq.create('comment_events');

-- Asks the send-events function to deliver what is due. Until the project URL
-- and the database's secret key are in Vault (see Search in
-- docs/architecture.md), events wait in the queue.
create function private.wake_event_sender()
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.wake_event_sender() from public, anon, authenticated;

-- Queues comment.created for one comment, whose person asked an agent, for
-- every live subscription of that person's that watches its project or its
-- thread's file, and wakes the sender when there is one. Never anyone else's.
create function private.queue_comment_event(author_id uuid, project_id uuid, file_id uuid, comment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.queue_comment_event(uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- Queues comment.created for a new comment that asks an agent. The rule: a
-- person wrote it (not an agent), on their own open thread that asks an
-- agent, so it is either that thread's opening comment or their own reply to
-- it. When the opening comment is written the thread already asks, and a
-- reply is written before the thread records it was asked again, so both are
-- seen here.
create function private.queue_comment_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.queue_comment_events() from public, anon, authenticated;

create trigger queue_comment_events
  after insert on public.comments
  for each row
  execute function private.queue_comment_events();

-- Turning Ask an agent on for an existing thread asks too, though it writes
-- no comment, and so does its creator reopening it, as a person, while it is
-- on (set_comment_resolved records that as asking again): it queues
-- comment.created for the thread's creator, with their latest comment on it
-- written as a person, when the thread is open. Only its creator, as a
-- person, does either (set_comment_ask_agent, set_comment_resolved); anyone
-- else reopening it leaves the ask as it was, so nothing is sent. A new thread
-- that asks is seen when its opening comment is written, and a reply that
-- asks again changes a thread that is already open and asking, so neither
-- comes here. Turning it off sends nothing.
create function private.queue_ask_agent_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  latest uuid;
begin
  if new.ask_agent_revision is null or new.ask_agent_revision is not distinct from old.ask_agent_revision
    or new.created_by is null or new.resolved_at is not null
    or (old.ask_agent_revision is not null and old.resolved_at is null) then
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
$$;

revoke all on function private.queue_ask_agent_events() from public, anon, authenticated;

create trigger queue_ask_agent_events
  after update of ask_agent_revision on public.comment_threads
  for each row
  execute function private.queue_ask_agent_events();

-- What to send for one queued event, checked now: the subscription is live,
-- its agent is still connected, its person can still read the project, and
-- the comment still matches the rule and the subscription's file. Returns the
-- callback, the secrets to sign with and the event's data, or `deliver` false
-- and why. A subscription whose person lost the project or disconnected the
-- agent is removed. Only the send-events function calls this, through its
-- own database connection.
create function private.comment_event_delivery(subscription_id text, comment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.comment_event_delivery(text, uuid) from public, anon, authenticated;

-- Once a minute: removes expired subscriptions, and wakes the sender only
-- when an event is due (a retry whose wait is over, or one a failed wake left).
create function private.sweep_comment_events()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.event_subscriptions s where s.expires_at <= now();
  if exists (select 1 from pgmq.q_comment_events q where q.vt <= clock_timestamp()) then
    perform private.wake_event_sender();
  end if;
end;
$$;

revoke all on function private.sweep_comment_events() from public, anon, authenticated;

select cron.schedule(
  'sweep-comment-events',
  '* * * * *',
  $$select private.sweep_comment_events()$$
);
