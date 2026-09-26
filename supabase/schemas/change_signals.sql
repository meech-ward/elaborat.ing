-- Change signals. When a project's revision goes up, the database broadcasts
-- the new revision on the project's private Realtime channel,
-- `project:<id>`. Devices with the project open then pull what changed. The
-- message says only which revision is now current, never which files changed
-- or what is in them.
--
-- Supabase's guides: Broadcast from the database
-- (https://supabase.com/docs/guides/realtime/broadcast) and Realtime
-- Authorization (https://supabase.com/docs/guides/realtime/authorization).

-- `realtime.send` never raises: if Realtime cannot take the message, it logs a
-- warning and the save goes ahead. A signal is only a hint to pull.
create function private.broadcast_project_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('revision', new.revision),
    'changed',
    'project:' || new.id::text,
    true
  );
  return null;
end;
$$;

revoke all on function private.broadcast_project_change() from public, anon, authenticated;

create trigger broadcast_change
  after update of revision on public.projects
  for each row
  when (new.revision is distinct from old.revision)
  execute function private.broadcast_project_change();

-- Realtime lets someone join a private channel when this policy lets them read
-- its messages, with `realtime.topic()` set to the channel's topic. There is no
-- insert policy, so no client can send on these channels.
create policy "People can receive change signals for projects they can read"
  on realtime.messages
  for select
  to authenticated
  using (
    extension = 'broadcast'
    and (select realtime.topic()) in (
      select 'project:' || readable.id::text
      from private.readable_project_ids() as readable (id)
    )
  );
