SET local check_function_bodies = off;

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
      perform private.queue_drawing_preview(new.id);
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
    -- Keep prior start time and cancellation reservation across a same-ID
    -- unsupported rename. Returning to a drawing must still honor its gap.
    -- Ordinary files that were never drawings do not acquire a job row.
    update private.drawing_preview_jobs set project_id = f.project_id,
      desired_generation = desired_generation + 1, attempts = 0, due_at = null,
      updated_at = clock_timestamp() where file_id = target_file;
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
