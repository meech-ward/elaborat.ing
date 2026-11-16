SET local check_function_bodies = off;

CREATE TABLE "private"."drawing_preview_dispatch" (
  "singleton"  boolean                  NOT NULL DEFAULT true,
  "not_before" timestamp with time zone NOT NULL,
  CONSTRAINT "drawing_preview_dispatch_pkey" PRIMARY KEY (singleton),
  CONSTRAINT "drawing_preview_dispatch_singleton_check" CHECK (singleton)
);

ALTER TABLE "private"."drawing_preview_dispatch"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "private"."drawing_preview_global_usage" (
  "day"      date    NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  CONSTRAINT "drawing_preview_global_usage_attempts_check" CHECK ((attempts >= 0)),
  CONSTRAINT "drawing_preview_global_usage_pkey" PRIMARY KEY (day)
);

ALTER TABLE "private"."drawing_preview_global_usage"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "private"."drawing_preview_jobs" (
  "file_id"            uuid                     NOT NULL,
  "project_id"         uuid                     NOT NULL,
  "desired_generation" bigint                   NOT NULL DEFAULT 1,
  "attempts"           integer                  NOT NULL DEFAULT 0,
  "due_at"             timestamp with time zone,
  "last_started_at"    timestamp with time zone,
  "claimed_generation" bigint,
  "lease_token"        uuid,
  "lease_expires_at"   timestamp with time zone,
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "drawing_preview_jobs_attempts_check" CHECK (((attempts >= 0) AND (attempts <= 1000))),
  CONSTRAINT "drawing_preview_jobs_desired_generation_check" CHECK ((desired_generation > 0)),
  CONSTRAINT "drawing_preview_jobs_lease" CHECK ((((lease_token IS NULL) AND (claimed_generation IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_token IS
    NOT NULL) AND (claimed_generation IS NOT NULL) AND (claimed_generation > 0) AND (lease_expires_at IS NOT NULL)))),
  CONSTRAINT "drawing_preview_jobs_pkey" PRIMARY KEY (file_id)
);

ALTER TABLE "private"."drawing_preview_jobs"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "private"."drawing_preview_leases" (
  "lease_token" uuid                     NOT NULL,
  "file_id"     uuid                     NOT NULL,
  "project_id"  uuid                     NOT NULL,
  "generation"  bigint                   NOT NULL,
  "expires_at"  timestamp with time zone NOT NULL,
  CONSTRAINT "drawing_preview_leases_generation_check" CHECK ((generation > 0)),
  CONSTRAINT "drawing_preview_leases_pkey" PRIMARY KEY (lease_token)
);

ALTER TABLE "private"."drawing_preview_leases"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "private"."drawing_preview_project_usage" (
  "project_id" uuid    NOT NULL,
  "day"        date    NOT NULL,
  "attempts"   integer NOT NULL DEFAULT 0,
  CONSTRAINT "drawing_preview_project_usage_attempts_check" CHECK ((attempts >= 0)),
  CONSTRAINT "drawing_preview_project_usage_pkey" PRIMARY KEY (project_id, day)
);

ALTER TABLE "private"."drawing_preview_project_usage"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."drawing_previews" (
  "file_id"      uuid                     NOT NULL,
  "project_id"   uuid                     NOT NULL,
  "file_version" bigint                   NOT NULL,
  "generation"   bigint                   NOT NULL,
  "status"       text                     NOT NULL DEFAULT 'pending'::text,
  "png"          bytea,
  "metadata"     jsonb,
  "error_code"   text,
  "message"      text,
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "drawing_previews_error_code_check" CHECK ((octet_length(error_code) <= 80)),
  CONSTRAINT "drawing_previews_file_version_check" CHECK ((file_version > 0)),
  CONSTRAINT "drawing_previews_generation_check" CHECK ((generation > 0)),
  CONSTRAINT "drawing_previews_message_check" CHECK ((octet_length(message) <= 1200)),
  CONSTRAINT "drawing_previews_metadata_bound" CHECK (((metadata IS NULL) OR ((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 16384)))),
  CONSTRAINT "drawing_previews_pkey" PRIMARY KEY (file_id),
  CONSTRAINT "drawing_previews_png_bound" CHECK (((png IS NULL) OR ((octet_length(png) > 0) AND (octet_length(png) <= 98304)))),
  CONSTRAINT "drawing_previews_state" CHECK ((((status = 'ready'::text) AND (png IS NOT NULL) AND (metadata IS
    NOT NULL) AND (error_code IS NULL) AND (message IS NULL)) OR
    ((status = 'pending'::text) AND (png IS NULL) AND (metadata IS NULL) AND (error_code IS NULL) AND (message IS NULL)) OR
    ((status = 'error'::text) AND (png IS NULL) AND (metadata IS NULL) AND (error_code IS NOT NULL) AND (message IS NOT NULL)))),
  CONSTRAINT "drawing_previews_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'error'::text])))
);

ALTER TABLE "public"."drawing_previews"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."drawing_previews" FROM "anon";

CREATE OR REPLACE FUNCTION private.affected_drawing_preview_roots (
  target_project uuid,
  changed_path   text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select f.id from public.project_files f
  where f.project_id = target_project and f.kind = 'text'
    and private.is_drawing_preview_path(f.path)
    and (f.path = changed_path or (f.path ~* '\.d2$' and
      (regexp_replace(f.path, '\.d2$', '.excalidraw', 'i') = changed_path
        or f.path || '.json' = changed_path)))
$function$;

CREATE OR REPLACE FUNCTION private.claim_drawing_preview_job()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare settings record; candidate record; picked private.drawing_preview_jobs;
  stamp timestamptz := clock_timestamp(); today date; result jsonb; token uuid;
begin
  perform private.require_drawing_preview_worker();
  -- Exact global active/daily limits require serialization across workers.
  perform pg_advisory_xact_lock(728431, 1);
  stamp := clock_timestamp(); today := (stamp at time zone 'UTC')::date;
  select * into settings from private.drawing_preview_limits();
  delete from private.drawing_preview_global_usage where day in
    (select day from private.drawing_preview_global_usage where day < today - 2 order by day limit 500);
  delete from private.drawing_preview_project_usage where (project_id, day) in
    (select project_id, day from private.drawing_preview_project_usage where day < today - 2 order by day, project_id limit 500);

  -- Existing files are backfilled in bounded batches, without schema DML.
  for candidate in
    select f.id from public.project_files f
    where f.kind = 'text' and private.is_drawing_preview_path(f.path)
      and (not exists (select 1 from public.drawing_previews p where p.file_id = f.id)
        or not exists (select 1 from private.drawing_preview_jobs j where j.file_id = f.id))
    order by f.id limit 25
  loop perform private.queue_drawing_preview(candidate.id); end loop;

  -- Abandoned work consumes an attempt. Superseded leases release their slot
  -- without changing the new generation's pending state or retry count.
  for candidate in select * from private.drawing_preview_jobs
    where lease_token is not null and lease_expires_at <= stamp for update skip locked
  loop
    if candidate.claimed_generation = candidate.desired_generation then
      update public.drawing_previews set status = 'error', png = null, metadata = null,
        error_code = 'lease_expired', message = 'The preview worker stopped before publishing.', updated_at = stamp
        where file_id = candidate.file_id and generation = candidate.desired_generation;
      update private.drawing_preview_jobs set due_at = case when attempts < settings.max_attempts
        then stamp + make_interval(secs => least(600, 30 * (2 ^ greatest(0, attempts - 1))::integer)) else null end
        where file_id = candidate.file_id;
    end if;
    update private.drawing_preview_jobs set lease_token = null, claimed_generation = null,
      lease_expires_at = null, updated_at = stamp where file_id = candidate.file_id;
  end loop;
  delete from private.drawing_preview_leases where lease_token in
    (select lease_token from private.drawing_preview_leases where expires_at <= stamp order by expires_at limit 500);
  perform private.defer_drawing_preview_quotas(stamp);
  if (select count(*) from private.drawing_preview_leases where expires_at > stamp) >= settings.active_jobs
    or coalesce((select attempts from private.drawing_preview_global_usage where day = today), 0) >= settings.global_daily then return null; end if;

  select j.* into picked from private.drawing_preview_jobs j
    join public.project_files f on f.id = j.file_id
    left join private.drawing_preview_project_usage u on u.project_id = j.project_id and u.day = today
    where j.lease_token is null and j.due_at <= stamp and j.attempts < settings.max_attempts
      and (j.last_started_at is null or j.last_started_at <= stamp - make_interval(secs => settings.start_gap_seconds))
      and coalesce(u.attempts, 0) < settings.project_daily
      and f.kind = 'text' and private.is_drawing_preview_path(f.path)
    order by j.due_at, j.file_id for update of j skip locked limit 1;
  if not found then return null; end if;
  token := gen_random_uuid();
  update private.drawing_preview_jobs set attempts = attempts + 1,
    last_started_at = stamp, lease_token = token, claimed_generation = desired_generation,
    lease_expires_at = stamp + make_interval(secs => settings.lease_seconds), updated_at = stamp
    where file_id = picked.file_id;
  update public.drawing_previews set status = 'pending', png = null, metadata = null,
    error_code = null, message = null, updated_at = stamp
    where file_id = picked.file_id and generation = picked.desired_generation;
  insert into private.drawing_preview_leases(lease_token, file_id, project_id, generation, expires_at)
    values (token, picked.file_id, picked.project_id, picked.desired_generation,
      stamp + make_interval(secs => settings.lease_seconds));
  insert into private.drawing_preview_global_usage(day, attempts) values (today, 1)
    on conflict (day) do update set attempts = private.drawing_preview_global_usage.attempts + 1;
  insert into private.drawing_preview_project_usage(project_id, day, attempts) values (picked.project_id, today, 1)
    on conflict (project_id, day) do update set attempts = private.drawing_preview_project_usage.attempts + 1;

  -- All source/canvas/layout rows (including absence) share this statement's
  -- MVCC snapshot. A subsequent change invalidates the generation/lease.
  select jsonb_build_object('file_id', f.id, 'project_id', f.project_id,
    'path', f.path, 'file_version', f.version, 'generation', picked.desired_generation,
    'lease_token', token, 'lease_expires_at', stamp + make_interval(secs => settings.lease_seconds),
    'attempt', picked.attempts + 1,
    'inputs', (select jsonb_agg(jsonb_build_object('path', p.path, 'id', i.id,
      'kind', i.kind, 'version', i.version, 'content', i.content) order by p.ordinal)
      from unnest(case when f.path ~* '\.d2$' then
        array[f.path, regexp_replace(f.path, '\.d2$', '.excalidraw', 'i'), f.path || '.json']
        else array[f.path] end) with ordinality p(path, ordinal)
      left join public.project_files i on i.project_id = f.project_id and i.path = p.path))
    into result from public.project_files f where f.id = picked.file_id;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION private.defer_drawing_preview_dispatch (
  seconds integer
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform private.require_drawing_preview_worker();
  if seconds is null or seconds < 5 or seconds > 3600 then
    raise exception 'The drawing preview dispatch delay must be between 5 and 3600 seconds' using errcode = '22023';
  end if;
  insert into private.drawing_preview_dispatch(singleton, not_before)
    values (true, clock_timestamp() + make_interval(secs => seconds))
    on conflict (singleton) do update set not_before = greatest(private.drawing_preview_dispatch.not_before, excluded.not_before);
end;
$function$;

CREATE OR REPLACE FUNCTION private.defer_drawing_preview_quotas (
  stamp timestamp with time zone
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare settings record; today date := (stamp at time zone 'UTC')::date;
  tomorrow timestamptz := ((stamp at time zone 'UTC')::date + 1)::timestamp at time zone 'UTC';
  global_used integer;
begin
  select * into settings from private.drawing_preview_limits();
  global_used := coalesce((select attempts from private.drawing_preview_global_usage where day = today), 0);
  with blocked as (
    select j.file_id, j.desired_generation from private.drawing_preview_jobs j
      left join private.drawing_preview_project_usage u on u.project_id = j.project_id and u.day = today
    where j.due_at <= stamp and (j.lease_token is null or j.lease_expires_at <= stamp)
      and (global_used >= settings.global_daily or coalesce(u.attempts, 0) >= settings.project_daily)
    order by j.due_at, j.file_id for update of j skip locked limit 250
  ), deferred as (
    update private.drawing_preview_jobs j set due_at = tomorrow, updated_at = stamp
      from blocked b where j.file_id = b.file_id returning j.file_id, j.desired_generation
  ) update public.drawing_previews p set status = 'error', png = null, metadata = null,
    error_code = 'rate_limit', message = 'The drawing preview attempt limit was reached. Retries resume at '
      || to_char(tomorrow at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '.', updated_at = stamp
    from deferred d where p.file_id = d.file_id and p.generation = d.desired_generation;
end;
$function$;

CREATE OR REPLACE FUNCTION private.drawing_preview_lease_current (
  target_file       uuid,
  target_generation bigint,
  target_token      uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform private.require_drawing_preview_worker();
  return exists (select 1 from private.drawing_preview_jobs j
    join private.drawing_preview_leases l on l.lease_token = j.lease_token and l.file_id = j.file_id
    where j.file_id = target_file and j.desired_generation = target_generation
      and j.claimed_generation = target_generation and j.lease_token = target_token
      and j.lease_expires_at > clock_timestamp() and l.expires_at > clock_timestamp());
end;
$function$;

CREATE OR REPLACE FUNCTION private.drawing_preview_limits()
  RETURNS TABLE (
    active_jobs       integer,
    global_daily      integer,
    project_daily     integer,
    max_attempts      integer,
    quiet_seconds     integer,
    start_gap_seconds integer,
    lease_seconds     integer
  )
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  values (2, 500, 100, 5, 5, 10, 60)
$function$;

CREATE OR REPLACE FUNCTION private.fail_drawing_preview_job (
  target_file       uuid,
  target_generation bigint,
  target_token      uuid,
  code              text,
  detail            text,
  can_retry         boolean
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare job private.drawing_preview_jobs; settings record; stamp timestamptz := clock_timestamp();
begin
  perform private.require_drawing_preview_worker();
  select * into job from private.drawing_preview_jobs where file_id = target_file for update;
  if not found or job.lease_token is distinct from target_token or job.claimed_generation <> target_generation then
    delete from private.drawing_preview_leases where lease_token = target_token and file_id = target_file and generation = target_generation;
    return false;
  end if;
  select * into settings from private.drawing_preview_limits();
  if job.desired_generation = target_generation then
    update public.drawing_previews set status = 'error', png = null, metadata = null,
      error_code = left(coalesce(nullif(code, ''), 'render_failed'), 80),
      message = left(coalesce(nullif(detail, ''), 'The drawing preview failed.'), 300), updated_at = stamp
      where file_id = target_file and generation = target_generation;
    update private.drawing_preview_jobs set due_at = case when can_retry and attempts < settings.max_attempts
      then greatest(stamp + make_interval(secs => least(600, 30 * (2 ^ greatest(0, attempts - 1))::integer)),
        last_started_at + make_interval(secs => settings.start_gap_seconds)) else null end
      where file_id = target_file;
  end if;
  update private.drawing_preview_jobs set lease_token = null, claimed_generation = null,
    lease_expires_at = null, updated_at = stamp where file_id = target_file;
  delete from private.drawing_preview_leases where lease_token = target_token and file_id = target_file;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION private.is_drawing_preview_path (
  path text
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select path ~* '\.(excalidraw(\.md)?|d2)$'
$function$;

CREATE OR REPLACE FUNCTION private.publish_drawing_preview (
  target_file       uuid,
  target_generation bigint,
  target_token      uuid,
  image             bytea,
  details           jsonb
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare job private.drawing_preview_jobs;
begin
  perform private.require_drawing_preview_worker();
  select * into job from private.drawing_preview_jobs where file_id = target_file for update;
  if not found or job.desired_generation <> target_generation or job.claimed_generation <> target_generation
    or job.lease_token is distinct from target_token or job.lease_expires_at <= clock_timestamp() then return false; end if;
  if not exists (select 1 from private.drawing_preview_leases where lease_token = target_token
    and file_id = target_file and generation = target_generation and expires_at > clock_timestamp()) then return false; end if;
  if image is null or octet_length(image) > 98304 or substring(image from 1 for 8) <> decode('89504e470d0a1a0a', 'hex')
    or details is null or jsonb_typeof(details) <> 'object' or octet_length(details::text) > 16384
    or coalesce(details ->> 'snapshot', '') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(details -> 'inputs') is distinct from 'array'
    or jsonb_array_length(details -> 'inputs') > 3
    or coalesce(details ->> 'renderer_build', '') !~ '^[A-Za-z0-9_-]{8,64}$'
    or details ->> 'profile' is distinct from 'light-v1'
    or details -> 'outcome' ->> 'status' is distinct from 'ready'
    or details -> 'outcome' ->> 'input_digest' is distinct from details ->> 'snapshot' then
    raise exception 'The drawing preview artifact is invalid or exceeds its limits' using errcode = '22023';
  end if;
  update public.drawing_previews p set status = 'ready', png = image, metadata = details,
    error_code = null, message = null, updated_at = clock_timestamp()
    where p.file_id = target_file and p.generation = target_generation;
  if not found then return false; end if;
  update private.drawing_preview_jobs set due_at = null, lease_token = null,
    claimed_generation = null, lease_expires_at = null, updated_at = clock_timestamp()
    where file_id = target_file;
  delete from private.drawing_preview_leases where lease_token = target_token and file_id = target_file;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION private.queue_changed_drawing_previews()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare target uuid; targets uuid[] := '{}';
begin
  if tg_op = 'UPDATE' and new.project_id = old.project_id and new.path = old.path and new.kind = old.kind
    and new.content = old.content and new.version = old.version then return null; end if;
  if tg_op <> 'DELETE' then
    -- A rename to an unsupported type removes only its derived artifact.
    if new.kind <> 'text' or not private.is_drawing_preview_path(new.path) then
      delete from public.drawing_previews where file_id = new.id;
      delete from private.drawing_preview_jobs where file_id = new.id;
    end if;
    select coalesce(array_agg(id), '{}') into targets
      from private.affected_drawing_preview_roots(new.project_id, new.path) id;
  end if;
  if tg_op <> 'INSERT' then
    select targets || coalesce(array_agg(id), '{}') into targets
      from private.affected_drawing_preview_roots(old.project_id, old.path) id;
  end if;
  -- Stable ordering keeps multi-root invalidation lock order consistent.
  for target in select distinct id from unnest(targets) id order by id loop
    perform private.queue_drawing_preview(target);
  end loop;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION private.queue_drawing_preview (
  target_file uuid
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare f public.project_files; next_generation bigint; settings record;
begin
  select * into f from public.project_files where id = target_file;
  if not found then return; end if;
  if f.kind <> 'text' or not private.is_drawing_preview_path(f.path) then
    delete from public.drawing_previews where file_id = target_file;
    delete from private.drawing_preview_jobs where file_id = target_file;
    return;
  end if;
  select * into settings from private.drawing_preview_limits();
  insert into private.drawing_preview_jobs(file_id, project_id, due_at)
    values (f.id, f.project_id, clock_timestamp() + make_interval(secs => settings.quiet_seconds))
    on conflict (file_id) do update set
      project_id = excluded.project_id,
      desired_generation = private.drawing_preview_jobs.desired_generation + 1,
      attempts = 0,
      due_at = greatest(clock_timestamp() + make_interval(secs => settings.quiet_seconds),
        private.drawing_preview_jobs.last_started_at + make_interval(secs => settings.start_gap_seconds)),
      updated_at = clock_timestamp()
    returning desired_generation into next_generation;
  insert into public.drawing_previews(file_id, project_id, file_version, generation)
    values (f.id, f.project_id, f.version, next_generation)
    on conflict (file_id) do update set
      project_id = excluded.project_id, file_version = excluded.file_version,
      generation = excluded.generation, status = 'pending', png = null, metadata = null,
      error_code = null, message = null, updated_at = clock_timestamp();
exception when foreign_key_violation then
  -- A root deleted concurrently with backfill needs no artifact or job.
  return;
end;
$function$;

CREATE OR REPLACE FUNCTION private.release_drawing_preview_lease (
  target_file  uuid,
  target_token uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare job private.drawing_preview_jobs;
begin
  perform private.require_drawing_preview_worker();
  select * into job from private.drawing_preview_jobs where file_id = target_file for update;
  if not found or job.lease_token is distinct from target_token then
    delete from private.drawing_preview_leases where lease_token = target_token and file_id = target_file;
    return found;
  end if;
  if job.claimed_generation = job.desired_generation then
    return private.fail_drawing_preview_job(target_file, job.claimed_generation, target_token,
      'worker_released', 'The preview worker ended without publishing.', true);
  end if;
  update private.drawing_preview_jobs set lease_token = null, claimed_generation = null,
    lease_expires_at = null, updated_at = clock_timestamp()
    where file_id = target_file and lease_token = target_token;
  delete from private.drawing_preview_leases where lease_token = target_token and file_id = target_file;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION private.require_drawing_preview_worker()
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  if current_setting('role', true) = 'service_role'
    or (current_setting('role', true) in ('none', 'postgres', 'supabase_admin')
      and session_user in ('postgres', 'supabase_admin')) then return; end if;
  raise exception 'Only the drawing preview worker can perform this operation' using errcode = '42501';
end;
$function$;

CREATE OR REPLACE FUNCTION private.wake_drawing_previews()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare project_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  secret_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'embed_secret_key');
  settings record; stamp timestamptz := clock_timestamp(); today date;
begin
  if exists (select 1 from private.drawing_preview_dispatch where not_before > stamp) then return; end if;
  if project_url is null or secret_key is null then return; end if;
  select * into settings from private.drawing_preview_limits();
  today := (stamp at time zone 'UTC')::date;
  perform private.defer_drawing_preview_quotas(stamp);
  delete from private.drawing_preview_leases where lease_token in
    (select lease_token from private.drawing_preview_leases where expires_at <= stamp order by expires_at limit 500);
  if coalesce((select attempts from private.drawing_preview_global_usage where day = today), 0) >= settings.global_daily
    or (select count(*) from private.drawing_preview_leases where expires_at > stamp) >= settings.active_jobs then return; end if;
  if not exists (select 1 from private.drawing_preview_jobs j
    left join private.drawing_preview_project_usage u on u.project_id = j.project_id and u.day = today
    where j.due_at <= stamp and (j.lease_token is null or j.lease_expires_at <= stamp)
      and coalesce(u.attempts, 0) < settings.project_daily)
    and not exists (select 1 from public.project_files f
      left join private.drawing_preview_project_usage u on u.project_id = f.project_id and u.day = today
      where f.kind = 'text' and private.is_drawing_preview_path(f.path)
        and coalesce(u.attempts, 0) < settings.project_daily
        and (not exists (select 1 from public.drawing_previews p where p.file_id = f.id)
          or not exists (select 1 from private.drawing_preview_jobs j where j.file_id = f.id))) then return; end if;
  perform net.http_post(url => project_url || '/functions/v1/drawing-previews',
    headers => jsonb_build_object('Content-Type', 'application/json', 'apikey', secret_key),
    body => '{}'::jsonb, timeout_milliseconds => 55000);
end;
$function$;

CREATE OR REPLACE FUNCTION public.claim_drawing_preview_job()
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.claim_drawing_preview_job()
$function$;

REVOKE ALL ON FUNCTION "public"."claim_drawing_preview_job"() FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.defer_drawing_preview_dispatch (
  seconds integer DEFAULT 300
)
  RETURNS void
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.defer_drawing_preview_dispatch(seconds)
$function$;

REVOKE ALL ON FUNCTION "public"."defer_drawing_preview_dispatch"(integer) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.drawing_preview_lease_current (
  file_id     uuid,
  generation  bigint,
  lease_token uuid
)
  RETURNS boolean
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.drawing_preview_lease_current(file_id, generation, lease_token)
$function$;

REVOKE ALL ON FUNCTION "public"."drawing_preview_lease_current"(uuid, bigint, uuid) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.fail_drawing_preview_job (
  file_id     uuid,
  generation  bigint,
  lease_token uuid,
  error_code  text,
  message     text,
  retryable   boolean DEFAULT true
)
  RETURNS boolean
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.fail_drawing_preview_job(file_id, generation, lease_token, error_code, message, retryable)
$function$;

REVOKE ALL ON FUNCTION "public"."fail_drawing_preview_job"(uuid, bigint, uuid, text, text, boolean) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.publish_drawing_preview (
  file_id     uuid,
  generation  bigint,
  lease_token uuid,
  png         bytea,
  metadata    jsonb
)
  RETURNS boolean
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.publish_drawing_preview(file_id, generation, lease_token, png, metadata)
$function$;

REVOKE ALL ON FUNCTION "public"."publish_drawing_preview"(uuid, bigint, uuid, bytea, jsonb) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.release_drawing_preview_lease (
  file_id     uuid,
  lease_token uuid
)
  RETURNS boolean
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.release_drawing_preview_lease(file_id, lease_token)
$function$;

REVOKE ALL ON FUNCTION "public"."release_drawing_preview_lease"(uuid, uuid) FROM PUBLIC, "anon", "authenticated";

ALTER TABLE "private"."drawing_preview_jobs"
  ADD CONSTRAINT "drawing_preview_jobs_file_id_fkey" FOREIGN KEY (file_id) REFERENCES public.project_files(id) ON DELETE CASCADE;

ALTER TABLE "private"."drawing_preview_jobs"
  ADD CONSTRAINT "drawing_preview_jobs_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "private"."drawing_preview_project_usage"
  ADD CONSTRAINT "drawing_preview_project_usage_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."drawing_previews"
  ADD CONSTRAINT "drawing_previews_file_id_fkey" FOREIGN KEY (file_id) REFERENCES public.project_files(id) ON DELETE CASCADE;

ALTER TABLE "public"."drawing_previews"
  ADD CONSTRAINT "drawing_previews_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

CREATE INDEX drawing_preview_jobs_active_idx ON private.drawing_preview_jobs USING btree (lease_expires_at)
  WHERE (lease_token IS NOT NULL);

CREATE INDEX drawing_preview_jobs_due_idx ON private.drawing_preview_jobs USING btree (due_at, file_id)
  WHERE ((due_at IS NOT NULL) AND (lease_token IS NULL));

CREATE INDEX drawing_preview_jobs_project_id_idx ON private.drawing_preview_jobs USING btree (project_id);

CREATE INDEX drawing_preview_leases_expiry_idx ON private.drawing_preview_leases USING btree (expires_at);

CREATE INDEX drawing_previews_project_id_idx ON public.drawing_previews USING btree (project_id);

CREATE TRIGGER queue_changed_drawing_previews
  AFTER INSERT OR DELETE OR UPDATE OF content, path, kind, VERSION, project_id ON public.project_files
  FOR EACH ROW
  EXECUTE FUNCTION private.queue_changed_drawing_previews();

CREATE POLICY "People can read drawing previews in their projects" ON "public"."drawing_previews"
  FOR SELECT
  TO "authenticated"
  USING ((project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids)));

REVOKE ALL ON FUNCTION "private"."affected_drawing_preview_roots"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."affected_drawing_preview_roots"(uuid, text) TO "postgres";

REVOKE ALL ON FUNCTION "private"."claim_drawing_preview_job"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."claim_drawing_preview_job"() TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."defer_drawing_preview_dispatch"(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."defer_drawing_preview_dispatch"(integer) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."defer_drawing_preview_quotas"(timestamp WITH time zone) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."defer_drawing_preview_quotas"(timestamp WITH time zone) TO "postgres";

REVOKE ALL ON FUNCTION "private"."drawing_preview_lease_current"(uuid, bigint, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."drawing_preview_lease_current"(uuid, bigint, uuid) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."drawing_preview_limits"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."drawing_preview_limits"() TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."fail_drawing_preview_job"(uuid, bigint, uuid, text, text, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."fail_drawing_preview_job"(uuid, bigint, uuid, text, text, boolean) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."is_drawing_preview_path"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."is_drawing_preview_path"(text) TO "postgres";

REVOKE ALL ON FUNCTION "private"."publish_drawing_preview"(uuid, bigint, uuid, bytea, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."publish_drawing_preview"(uuid, bigint, uuid, bytea, jsonb) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."queue_changed_drawing_previews"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."queue_changed_drawing_previews"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."queue_drawing_preview"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."queue_drawing_preview"(uuid) TO "postgres";

REVOKE ALL ON FUNCTION "private"."release_drawing_preview_lease"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."release_drawing_preview_lease"(uuid, uuid) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."require_drawing_preview_worker"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."require_drawing_preview_worker"() TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."wake_drawing_previews"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."wake_drawing_previews"() TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."claim_drawing_preview_job"() TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."defer_drawing_preview_dispatch"(integer) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."drawing_preview_lease_current"(uuid, bigint, uuid) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."fail_drawing_preview_job"(uuid, bigint, uuid, text, text, boolean) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."publish_drawing_preview"(uuid, bigint, uuid, bytea, jsonb) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."release_drawing_preview_lease"(uuid, uuid) TO "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."drawing_preview_dispatch" TO "postgres";

GRANT SELECT ON TABLE "private"."drawing_preview_dispatch" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."drawing_preview_global_usage" TO "postgres";

GRANT SELECT ON TABLE "private"."drawing_preview_global_usage" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."drawing_preview_jobs" TO "postgres";

GRANT SELECT ON TABLE "private"."drawing_preview_jobs" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."drawing_preview_leases" TO "postgres";

GRANT SELECT ON TABLE "private"."drawing_preview_leases" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."drawing_preview_project_usage" TO "postgres";

GRANT SELECT ON TABLE "private"."drawing_preview_project_usage" TO "service_role";

REVOKE ALL ON TABLE "public"."drawing_previews" FROM "authenticated";

GRANT SELECT ON TABLE "public"."drawing_previews" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."drawing_previews" TO "postgres";

REVOKE ALL ON TABLE "public"."drawing_previews" FROM "service_role";

GRANT SELECT ON TABLE "public"."drawing_previews" TO "service_role";

SELECT cron.schedule_in_database('process-drawing-previews', '5 seconds', 'select private.wake_drawing_previews()', 'postgres', NULL, true);
