SET local check_function_bodies = off;

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
    error_code = 'daily_limit', message = 'The drawing preview attempt limit was reached. Retries resume at '
      || to_char(tomorrow at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '.', updated_at = stamp
    from deferred d where p.file_id = d.file_id and p.generation = d.desired_generation;
end;
$function$;
