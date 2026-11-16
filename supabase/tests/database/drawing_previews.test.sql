begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select table_privs_are('public', 'drawing_previews', 'authenticated', array['SELECT'], 'People only read derived previews');
select table_privs_are('public', 'drawing_previews', 'anon', array[]::text[], 'Anonymous users cannot read previews');
select policies_are('public', 'drawing_previews', array['People can read drawing previews in their projects'], 'Previews use project access');
select ok((select bool_and(relrowsecurity) from pg_class where oid in
  ('public.drawing_previews'::regclass, 'private.drawing_preview_jobs'::regclass,
   'private.drawing_preview_leases'::regclass, 'private.drawing_preview_global_usage'::regclass,
   'private.drawing_preview_project_usage'::regclass, 'private.drawing_preview_dispatch'::regclass)), 'Every preview table has RLS');
select table_privs_are('private', 'drawing_preview_jobs', 'authenticated', array[]::text[], 'People cannot read or modify jobs');
select table_privs_are('private', 'drawing_preview_jobs', 'anon', array[]::text[], 'Anonymous users cannot touch jobs');
select table_privs_are('private', 'drawing_preview_leases', 'authenticated', array[]::text[], 'People cannot alter independent browser reservations');
select table_privs_are('private', 'drawing_preview_leases', 'anon', array[]::text[], 'Anonymous users cannot alter browser reservations');
select table_privs_are('private', 'drawing_preview_global_usage', 'authenticated', array[]::text[], 'Global counters are private');
select table_privs_are('private', 'drawing_preview_global_usage', 'anon', array[]::text[], 'Anonymous users cannot touch global counters');
select table_privs_are('private', 'drawing_preview_project_usage', 'authenticated', array[]::text[], 'Project counters are private');
select table_privs_are('private', 'drawing_preview_project_usage', 'anon', array[]::text[], 'Anonymous users cannot touch project counters');
select table_privs_are('private', 'drawing_preview_dispatch', 'authenticated', array[]::text[], 'People cannot read or alter the dispatch cooldown');
select table_privs_are('private', 'drawing_preview_dispatch', 'anon', array[]::text[], 'Anonymous users cannot alter dispatch');
select function_privs_are('public', 'claim_drawing_preview_job', array[]::text[], 'authenticated', array[]::text[], 'People cannot claim browser work');
select function_privs_are('public', 'claim_drawing_preview_job', array[]::text[], 'anon', array[]::text[], 'Anonymous users cannot claim browser work');
select function_privs_are('private', 'claim_drawing_preview_job', array[]::text[], 'authenticated', array[]::text[], 'The private claim helper is also protected');
select function_privs_are('public', 'publish_drawing_preview', array['uuid', 'bigint', 'uuid', 'bytea', 'jsonb'], 'authenticated', array[]::text[], 'People cannot publish derived pixels');
select function_privs_are('public', 'publish_drawing_preview', array['uuid', 'bigint', 'uuid', 'bytea', 'jsonb'], 'service_role', array['EXECUTE'], 'Only the service API can publish pixels');
select function_privs_are('public', 'fail_drawing_preview_job', array['uuid', 'bigint', 'uuid', 'text', 'text', 'boolean'], 'authenticated', array[]::text[], 'People cannot change worker outcomes');
select function_privs_are('public', 'release_drawing_preview_lease', array['uuid', 'uuid'], 'authenticated', array[]::text[], 'People cannot release active leases');
select function_privs_are('public', 'drawing_preview_lease_current', array['uuid', 'bigint', 'uuid'], 'authenticated', array[]::text[], 'People cannot inspect lease state');
select function_privs_are('public', 'defer_drawing_preview_dispatch', array['integer'], 'authenticated', array[]::text[], 'People cannot pause the background service');
select function_privs_are('public', 'defer_drawing_preview_dispatch', array['integer'], 'service_role', array['EXECUTE'], 'The worker can back off unconfigured dispatch');
select function_privs_are('private', 'wake_drawing_previews', array[]::text[], 'authenticated', array[]::text[], 'People cannot wake the privileged worker');
select results_eq($$select * from private.drawing_preview_limits()$$,
  $$values (2, 500, 100, 5, 5, 10, 60)$$, 'Limits fix concurrency, UTC daily attempts, retries, quiet time and start spacing');
select isnt_empty($$select 1 from cron.job where jobname = 'process-drawing-previews' and schedule = '5 seconds'$$, 'Cron wakes the worker every five seconds');

insert into auth.users(id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com');
insert into public.projects(id, owner_id, title) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Alice previews'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Bob previews');
insert into public.project_files(id, project_id, path, content, version) values
  ('aaaaaaaa-1000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'flow.d2', 'a -> b', 1),
  ('aaaaaaaa-1000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'flow.excalidraw', '{"elements":[]}', 1),
  ('aaaaaaaa-1000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'flow.d2.json', '{}', 1),
  ('aaaaaaaa-1000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'sketch.excalidraw', '{"elements":[]}', 1),
  ('aaaaaaaa-1000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', 'obsidian.excalidraw.md', '# Drawing', 1),
  ('aaaaaaaa-1000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001', 'note.md', '# Plain note', 1),
  ('bbbbbbbb-1000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'secret.excalidraw', '{"elements":[]}', 1);

select is((select count(*) from public.drawing_previews), 5::bigint, 'Only supported roots get artifacts, not ordinary notes or D2 sidecars');
select is((select count(*) from private.drawing_preview_jobs), 5::bigint, 'Each supported root has one coalescing job');
select ok((select bool_and(png is null and metadata is null and status = 'pending') from public.drawing_previews), 'New roots expose pending state without pixels');
select ok((select bool_and(due_at > clock_timestamp() + interval '4 seconds') from private.drawing_preview_jobs), 'Jobs wait for a real five-second quiet window');
select is(public.claim_drawing_preview_job(), null::jsonb, 'Nothing claims before the quiet window');

-- Keep scheduling deterministic without sleeping. Production timing is
-- asserted above; these changes affect only this rolled-back test transaction.
update private.drawing_preview_jobs set due_at = clock_timestamp() + interval '1 day';
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000001';
create temporary table preview_claims(name text primary key, job jsonb);
insert into preview_claims values ('first', public.claim_drawing_preview_job());
select ok((select job is not null from preview_claims where name = 'first'), 'A due job is claimed');
select is((select job ->> 'path' from preview_claims where name = 'first'), 'flow.d2', 'The claim identifies the exact root');
select is((select jsonb_array_length(job -> 'inputs') from preview_claims where name = 'first'), 3, 'D2 claim includes source and both companions');
select is((select job -> 'inputs' -> 1 ->> 'path' from preview_claims where name = 'first'), 'flow.excalidraw', 'The native companion is canonical');
select is((select job -> 'inputs' -> 2 ->> 'content' from preview_claims where name = 'first'), '{}', 'Companion bytes are captured with the source');
select is((select attempts from private.drawing_preview_global_usage where day = (clock_timestamp() at time zone 'UTC')::date), 1, 'Claim charges the global UTC-day budget once');
select is((select attempts from private.drawing_preview_project_usage where project_id = 'aaaaaaaa-0000-4000-8000-000000000001' and day = (clock_timestamp() at time zone 'UTC')::date), 1, 'Claim charges its project budget once');
select ok((select public.drawing_preview_lease_current((job ->> 'file_id')::uuid, (job ->> 'generation')::bigint, (job ->> 'lease_token')::uuid) from preview_claims where name = 'first'), 'The current lease can be checked without modifying it');

create function pg_temp.preview_png() returns bytea language sql as $$
  select decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==', 'base64')
$$;
create function pg_temp.preview_metadata(job jsonb) returns jsonb language sql as $$
  select jsonb_build_object('snapshot', repeat('a', 64), 'inputs',
    (select jsonb_agg((item - 'content' - 'kind') || jsonb_build_object('sha256', case when item ->> 'id' is null then null else repeat('b', 64) end)) from jsonb_array_elements(job -> 'inputs') item),
    'renderer_build', 'deadbeefdeadbeef', 'profile', 'light-v1', 'outcome',
    jsonb_build_object('job_id', 'dddddddd-0000-4000-8000-000000000001', 'input_digest', repeat('a', 64),
      'renderer_build', 'deadbeefdeadbeef', 'status', 'ready', 'profile', 'light-v1',
      'rendered_from', case when job ->> 'path' ~* '\.d2$' then 'projected_diagram' else 'saved_scene' end,
      'regenerated', false, 'view_box', jsonb_build_array(0, 0, 10, 10), 'region', jsonb_build_object('x', 0, 'y', 0, 'width', 1, 'height', 1),
      'pixel_width', 1, 'pixel_height', 1, 'scale', 0.1, 'diagnostics', '[]'::jsonb))
$$;
create function pg_temp.publish_claim(name text, image bytea default pg_temp.preview_png()) returns boolean language sql as $$
  select public.publish_drawing_preview((job ->> 'file_id')::uuid, (job ->> 'generation')::bigint,
    (job ->> 'lease_token')::uuid, image, pg_temp.preview_metadata(job)) from preview_claims where preview_claims.name = publish_claim.name
$$;
select throws_ok($$select pg_temp.publish_claim('first', decode(repeat('00', 98305), 'hex'))$$,
  '22023', 'The drawing preview artifact is invalid or exceeds its limits', 'Oversized image data is refused atomically');
select throws_ok($$select pg_temp.publish_claim('first', decode('00010203', 'hex'))$$,
  '22023', 'The drawing preview artifact is invalid or exceeds its limits', 'A non-PNG artifact is refused');
select throws_ok($$select public.publish_drawing_preview((job ->> 'file_id')::uuid, (job ->> 'generation')::bigint,
  (job ->> 'lease_token')::uuid, pg_temp.preview_png(), pg_temp.preview_metadata(job) || jsonb_build_object('padding', repeat('x', 16384)))
  from preview_claims where name = 'first'$$, '22023', 'The drawing preview artifact is invalid or exceeds its limits', 'Metadata is bounded before publishing');

-- A companion commit invalidates pixels and generation while its old lease
-- remains reserved, so repeated updates cannot open extra active slots.
update public.project_files set content = '{"elements":[],"changed":true}', version = 2
  where id = 'aaaaaaaa-1000-4000-8000-000000000002';
select ok((select not public.drawing_preview_lease_current((job ->> 'file_id')::uuid, (job ->> 'generation')::bigint, (job ->> 'lease_token')::uuid) from preview_claims where name = 'first'), 'A companion commit cancels the old generation');
select is((select status from public.drawing_previews where file_id = 'aaaaaaaa-1000-4000-8000-000000000001'), 'pending', 'D2 is pending immediately after its companion changes');
select ok((select lease_token is not null and attempts = 0 and desired_generation > claimed_generation from private.drawing_preview_jobs where file_id = 'aaaaaaaa-1000-4000-8000-000000000001'), 'The superseded lease stays reserved while new attempts reset');
select is(pg_temp.publish_claim('first'), false, 'A superseded publisher stores nothing');
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000004';
insert into preview_claims values ('second', public.claim_drawing_preview_job());
select ok((select job is not null from preview_claims where name = 'second'), 'A second browser slot is available');
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000005';
select is(public.claim_drawing_preview_job(), null::jsonb, 'The global two-active limit includes superseded work');
select ok((select public.fail_drawing_preview_job((job ->> 'file_id')::uuid, (job ->> 'generation')::bigint,
  (job ->> 'lease_token')::uuid, 'cancelled', 'Superseded', true) from preview_claims where name = 'first'), 'The old worker acknowledges cancellation');
select ok((select attempts = 0 and lease_token is null from private.drawing_preview_jobs where file_id = 'aaaaaaaa-1000-4000-8000-000000000001'), 'Old cancellation does not mutate the new generation retry count');
update private.drawing_preview_jobs set due_at = clock_timestamp() + interval '1 day'
  where file_id <> 'aaaaaaaa-1000-4000-8000-000000000001';
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000001';
select is(public.claim_drawing_preview_job(), null::jsonb, 'Even a forced due time cannot bypass the ten-second start gap');
update private.drawing_preview_jobs set last_started_at = clock_timestamp() - interval '11 seconds'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000001';
insert into preview_claims values ('current', public.claim_drawing_preview_job());
select ok((select job is not null from preview_claims where name = 'current'), 'The new generation claims once start spacing permits');
select is(pg_temp.publish_claim('current'), true, 'Only the current generation and token publish');
select ok((select status = 'ready' and png = pg_temp.preview_png() and metadata ->> 'snapshot' = repeat('a', 64)
  from public.drawing_previews where file_id = 'aaaaaaaa-1000-4000-8000-000000000001'), 'The bounded PNG and full metadata publish together');
select ok((select due_at is null and lease_token is null from private.drawing_preview_jobs where file_id = 'aaaaaaaa-1000-4000-8000-000000000001'), 'Successful work is not claimed repeatedly');
select is(pg_temp.publish_claim('first'), false, 'A late old result cannot replace current pixels');

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is((select count(*) from public.drawing_previews), 4::bigint, 'Alice reads only her own project previews');
select is((select count(*) from public.drawing_previews where project_id = 'bbbbbbbb-0000-4000-8000-000000000001'), 0::bigint, 'Alice cannot see Bob pixels or preview state');
select throws_ok($$update public.drawing_previews set png = null$$, '42501', null, 'A person cannot change derived pixels');
select throws_ok($$select public.claim_drawing_preview_job()$$, '42501', null, 'A person cannot start browser work');
select throws_ok($$select public.defer_drawing_preview_dispatch(300)$$, '42501', null, 'A person cannot use the cooldown to stop previews');
select throws_ok($$select * from private.drawing_preview_jobs$$, '42501', null, 'A person cannot inspect another project queue');
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is((select count(*) from public.drawing_previews), 1::bigint, 'Bob cannot see Alice previews before sharing');
reset role;
insert into public.project_members(project_id, user_id, role, accepted_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'viewer', now());
set local role authenticated;
select is((select count(*) from public.drawing_previews), 5::bigint, 'An accepted viewer can read shared previews');
reset role;
update public.project_members set role = 'commenter' where project_id = 'aaaaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
select is((select count(*) from public.drawing_previews), 5::bigint, 'Commenters can read shared previews');
reset role;
update public.project_members set role = 'editor' where project_id = 'aaaaaaaa-0000-4000-8000-000000000001';
update public.projects set archived_at = now() where id = 'aaaaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
select is((select count(*) from public.drawing_previews), 5::bigint, 'Editors can read previews in archived projects');
reset role;
delete from public.project_members where project_id = 'aaaaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
select is((select count(*) from public.drawing_previews), 1::bigint, 'Revocation immediately hides shared pixels');
set local role anon;
select throws_ok($$select * from public.drawing_previews$$, '42501', null, 'Anonymous clients cannot read any preview');
reset role;

update public.projects set archived_at = null where id = 'aaaaaaaa-0000-4000-8000-000000000001';
update public.project_files set content = 'a -> c', version = 3 where id = 'aaaaaaaa-1000-4000-8000-000000000001';
select ok((select status = 'pending' and png is null and metadata is null and file_version = 3
  from public.drawing_previews where file_id = 'aaaaaaaa-1000-4000-8000-000000000001'), 'A root save immediately clears the old PNG and metadata');

-- Exact UTC-day caps apply before reserving a browser or charging attempts.
select public.release_drawing_preview_lease((job ->> 'file_id')::uuid, (job ->> 'lease_token')::uuid) from preview_claims where name = 'second';
update private.drawing_preview_jobs set due_at = clock_timestamp() + interval '1 day';
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second', last_started_at = clock_timestamp() - interval '11 seconds'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000001';
update private.drawing_preview_global_usage set attempts = 500 where day = (clock_timestamp() at time zone 'UTC')::date;
select is(public.claim_drawing_preview_job(), null::jsonb, 'The 500th daily global attempt closes the service budget');
select is((select error_code from public.drawing_previews where file_id = 'aaaaaaaa-1000-4000-8000-000000000001'), 'daily_limit', 'Daily quota exhaustion is visible instead of preparing forever');
select is((select due_at from private.drawing_preview_jobs where file_id = 'aaaaaaaa-1000-4000-8000-000000000001'),
  (((clock_timestamp() at time zone 'UTC')::date + 1)::timestamp at time zone 'UTC'), 'Exhausted jobs remain queued for the next UTC day');
update private.drawing_preview_global_usage set attempts = 499 where day = (clock_timestamp() at time zone 'UTC')::date;
update private.drawing_preview_project_usage set attempts = 100 where project_id = 'aaaaaaaa-0000-4000-8000-000000000001' and day = (clock_timestamp() at time zone 'UTC')::date;
select is(public.claim_drawing_preview_job(), null::jsonb, 'The project cap refuses attempt 101 even with global room');
select is((select attempts from private.drawing_preview_global_usage where day = (clock_timestamp() at time zone 'UTC')::date), 499, 'Refusal does not consume a global attempt');
update private.drawing_preview_project_usage set attempts = 99 where project_id = 'aaaaaaaa-0000-4000-8000-000000000001' and day = (clock_timestamp() at time zone 'UTC')::date;
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second', last_started_at = clock_timestamp() - interval '11 seconds'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000001';
insert into preview_claims values ('cap', public.claim_drawing_preview_job());
select ok((select job is not null from preview_claims where name = 'cap'), 'The last globally and project-allowed attempt is claimed');
select is((select attempts from private.drawing_preview_global_usage where day = (clock_timestamp() at time zone 'UTC')::date), 500, 'The exact global cap is not exceeded');
select is((select attempts from private.drawing_preview_project_usage where project_id = 'aaaaaaaa-0000-4000-8000-000000000001' and day = (clock_timestamp() at time zone 'UTC')::date), 100, 'The exact project cap is not exceeded');
select public.release_drawing_preview_lease((job ->> 'file_id')::uuid, (job ->> 'lease_token')::uuid) from preview_claims where name = 'cap';

truncate private.drawing_preview_global_usage, private.drawing_preview_project_usage;
update private.drawing_preview_jobs set due_at = clock_timestamp() + interval '1 day';
select private.queue_drawing_preview('aaaaaaaa-1000-4000-8000-000000000004');
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second', last_started_at = clock_timestamp() - interval '11 seconds'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000004';
insert into preview_claims values ('retry', public.claim_drawing_preview_job());
select public.fail_drawing_preview_job((job ->> 'file_id')::uuid, (job ->> 'generation')::bigint, (job ->> 'lease_token')::uuid,
  'temporary', 'Retry later', true) from preview_claims where name = 'retry';
select ok((select due_at > clock_timestamp() + interval '28 seconds' and attempts = 1
  from private.drawing_preview_jobs where file_id = 'aaaaaaaa-1000-4000-8000-000000000004'), 'A transient failure schedules bounded backoff');
do $$declare job jsonb; begin
  for i in 2..5 loop
    update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second', last_started_at = clock_timestamp() - interval '11 seconds'
      where file_id = 'aaaaaaaa-1000-4000-8000-000000000004';
    job := public.claim_drawing_preview_job();
    if job is null then raise exception 'Expected retry claim'; end if;
    perform public.fail_drawing_preview_job((job ->> 'file_id')::uuid, (job ->> 'generation')::bigint,
      (job ->> 'lease_token')::uuid, 'temporary', 'Retry later', true);
  end loop;
end;$$;
select ok((select attempts = 5 and due_at is null and lease_token is null from private.drawing_preview_jobs
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000004'), 'Five failed attempts exhaust the generation');
select is((select attempts from private.drawing_preview_global_usage where day = (clock_timestamp() at time zone 'UTC')::date), 5, 'Each retry is charged exactly once');
select private.queue_drawing_preview('aaaaaaaa-1000-4000-8000-000000000004');
select ok((select attempts = 0 and due_at is not null from private.drawing_preview_jobs
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000004'), 'A fresh update revives exhausted work with a new generation');

-- Expired work retries; a superseded expiry must not replace pending state.
update private.drawing_preview_jobs set due_at = clock_timestamp() + interval '1 day';
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second', last_started_at = clock_timestamp() - interval '11 seconds'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000005';
insert into preview_claims values ('expired', public.claim_drawing_preview_job());
update private.drawing_preview_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000005';
update private.drawing_preview_leases set expires_at = clock_timestamp() - interval '1 second'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000005';
select is(public.claim_drawing_preview_job(), null::jsonb, 'An expired current attempt is rescheduled after backoff');
select is((select error_code from public.drawing_previews where file_id = 'aaaaaaaa-1000-4000-8000-000000000005'), 'lease_expired', 'Abandoned work gets an explicit error');
select ok((select lease_token is null and due_at > clock_timestamp() + interval '28 seconds' from private.drawing_preview_jobs
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000005'), 'Expired lease cleanup releases its slot and backs off');

-- Source and project cascades must not free a still-running reservation.
insert into public.project_files(id, project_id, path, content, version) values
  ('aaaaaaaa-1000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001', 'delete-active.excalidraw', '{}', 1),
  ('aaaaaaaa-1000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-000000000001', 'other-active.excalidraw', '{}', 1);
update private.drawing_preview_jobs set due_at = clock_timestamp() + interval '1 day';
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second'
  where file_id in ('aaaaaaaa-1000-4000-8000-000000000008', 'aaaaaaaa-1000-4000-8000-000000000009');
insert into preview_claims values ('delete-active', public.claim_drawing_preview_job());
insert into preview_claims values ('other-active', public.claim_drawing_preview_job());
delete from public.project_files where id = (select (job ->> 'file_id')::uuid from preview_claims where name = 'delete-active');
select is((select count(*) from private.drawing_preview_leases where expires_at > clock_timestamp()), 2::bigint, 'Source deletion retains both active reservations');
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second', last_started_at = clock_timestamp() - interval '11 seconds'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000001';
select is(public.claim_drawing_preview_job(), null::jsonb, 'Deleting a source cannot bypass global concurrency');
select ok((select public.release_drawing_preview_lease((job ->> 'file_id')::uuid, (job ->> 'lease_token')::uuid)
  from preview_claims where name = 'delete-active'), 'A deleted source lease can still be acknowledged');
insert into preview_claims values ('after-delete', public.claim_drawing_preview_job());
select ok((select job is not null from preview_claims where name = 'after-delete'), 'Cancellation acknowledgement frees exactly one slot');
select public.release_drawing_preview_lease((job ->> 'file_id')::uuid, (job ->> 'lease_token')::uuid)
  from preview_claims where name in ('other-active', 'after-delete');

insert into public.projects(id, owner_id, title) values
  ('cccccccc-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Disposable preview project');
insert into public.project_files(id, project_id, path, content, version) values
  ('cccccccc-1000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'active.excalidraw', '{}', 1);
update private.drawing_preview_jobs set due_at = clock_timestamp() + interval '1 day';
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second'
  where file_id in ('cccccccc-1000-4000-8000-000000000001', 'bbbbbbbb-1000-4000-8000-000000000001');
insert into preview_claims values ('before-project-delete-1', public.claim_drawing_preview_job());
insert into preview_claims values ('before-project-delete-2', public.claim_drawing_preview_job());
delete from public.projects where id = 'cccccccc-0000-4000-8000-000000000001';
select is((select count(*) from private.drawing_preview_leases where expires_at > clock_timestamp()), 2::bigint, 'Project deletion also retains its browser reservation');
select ok((select public.release_drawing_preview_lease((job ->> 'file_id')::uuid, (job ->> 'lease_token')::uuid)
  from preview_claims where name in ('before-project-delete-1', 'before-project-delete-2') and job ->> 'project_id' = 'cccccccc-0000-4000-8000-000000000001'), 'A deleted project lease remains releasable by token');
select public.release_drawing_preview_lease((job ->> 'file_id')::uuid, (job ->> 'lease_token')::uuid)
  from preview_claims where name in ('before-project-delete-1', 'before-project-delete-2') and job ->> 'project_id' <> 'cccccccc-0000-4000-8000-000000000001';

-- A supported/unsupported/supported rename keeps the root identity and its
-- last start time, so a path round trip cannot reset the ten-second gap.
insert into public.project_files(id, project_id, path, content, version) values
  ('aaaaaaaa-1000-4000-8000-000000000010', 'aaaaaaaa-0000-4000-8000-000000000001', 'roundtrip.excalidraw', '{}', 1);
update private.drawing_preview_jobs set due_at = clock_timestamp() + interval '1 day';
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000010';
insert into preview_claims values ('roundtrip-old', public.claim_drawing_preview_job());
update public.project_files set path = 'roundtrip.txt', version = 2 where id = 'aaaaaaaa-1000-4000-8000-000000000010';
select ok((select due_at is null and last_started_at is not null and lease_token is not null and desired_generation > claimed_generation
  from private.drawing_preview_jobs where file_id = 'aaaaaaaa-1000-4000-8000-000000000010'), 'Unsupported rename retains the prior start and cancellation reservation');
select is((select count(*) from public.drawing_previews where file_id = 'aaaaaaaa-1000-4000-8000-000000000010'), 0::bigint, 'Unsupported content has no readable drawing artifact');
update public.project_files set path = 'roundtrip.excalidraw', version = 3 where id = 'aaaaaaaa-1000-4000-8000-000000000010';
select public.fail_drawing_preview_job((job ->> 'file_id')::uuid, (job ->> 'generation')::bigint,
  (job ->> 'lease_token')::uuid, 'cancelled', 'Renamed', true) from preview_claims where name = 'roundtrip-old';
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000010';
select is(public.claim_drawing_preview_job(), null::jsonb, 'Returning to the same drawing ID does not bypass start spacing');
update private.drawing_preview_jobs set last_started_at = clock_timestamp() - interval '11 seconds'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000010';
insert into preview_claims values ('roundtrip-new', public.claim_drawing_preview_job());
select ok((select job is not null from preview_claims where name = 'roundtrip-new'), 'The renamed drawing becomes claimable after its original gap');
select public.release_drawing_preview_lease((job ->> 'file_id')::uuid, (job ->> 'lease_token')::uuid) from preview_claims where name = 'roundtrip-new';

-- Deleting and renaming companions also changes the D2 generation and
-- captures their absence rather than silently reusing old content.
create temporary table before_companion_delete as select generation from public.drawing_previews
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000001';
delete from public.project_files where id = 'aaaaaaaa-1000-4000-8000-000000000003';
select ok((select generation > (select generation from before_companion_delete) from public.drawing_previews
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000001'), 'A deleted D2 sidecar invalidates the root');
update private.drawing_preview_jobs set due_at = clock_timestamp() + interval '1 day';
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second', last_started_at = clock_timestamp() - interval '11 seconds'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000001';
insert into preview_claims values ('missing-sidecar', public.claim_drawing_preview_job());
select ok((select job -> 'inputs' -> 2 ->> 'id' is null and job -> 'inputs' -> 2 ->> 'content' is null
  from preview_claims where name = 'missing-sidecar'), 'A coherent claim represents a missing sidecar explicitly');
select public.release_drawing_preview_lease((job ->> 'file_id')::uuid, (job ->> 'lease_token')::uuid) from preview_claims where name = 'missing-sidecar';
update public.project_files set path = 'elsewhere.excalidraw', version = 4 where id = 'aaaaaaaa-1000-4000-8000-000000000002';
select ok((select status = 'pending' from public.drawing_previews where file_id = 'aaaaaaaa-1000-4000-8000-000000000001'), 'Renaming the native companion invalidates its former D2 root');
update public.project_files set path = 'sketch.txt', version = 5 where id = 'aaaaaaaa-1000-4000-8000-000000000004';
select is((select count(*) from public.drawing_previews where file_id = 'aaaaaaaa-1000-4000-8000-000000000004'), 0::bigint, 'Renaming to unsupported content removes its derived artifact');

-- Backfill is performed by claim, not top-level DML in declarative schemas.
create temporary table preview_count_before_backfill as select count(*) as n from public.drawing_previews;
alter table public.project_files disable trigger queue_changed_drawing_previews;
insert into public.project_files(id, project_id, path, content, version) values
  ('aaaaaaaa-1000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001', 'old.excalidraw', '{"elements":[]}', 1);
insert into public.project_files(id, project_id, path, content, version)
  select ('aaaaaaaa-2000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid, 'legacy-' || i || '.excalidraw', '{}', 1
  from generate_series(1, 30) i;
alter table public.project_files enable trigger queue_changed_drawing_previews;
update private.drawing_preview_jobs set due_at = clock_timestamp() + interval '1 day';
select is(public.claim_drawing_preview_job(), null::jsonb, 'Backfill queues existing files but still honors quiet time');
select is((select status from public.drawing_previews where file_id = 'aaaaaaaa-1000-4000-8000-000000000007'), 'pending', 'A preexisting root receives a bounded derived row');
select is((select count(*) from public.drawing_previews) - (select n from preview_count_before_backfill), 25::bigint, 'One claim backfills at most twenty-five roots');

insert into private.drawing_preview_global_usage(day, attempts) values ((clock_timestamp() at time zone 'UTC')::date - 3, 500);
insert into private.drawing_preview_project_usage(project_id, day, attempts) values
  ('aaaaaaaa-0000-4000-8000-000000000001', (clock_timestamp() at time zone 'UTC')::date - 3, 100);
select public.claim_drawing_preview_job();
select is((select count(*) from private.drawing_preview_global_usage where day < (clock_timestamp() at time zone 'UTC')::date - 2), 0::bigint, 'Old global ledgers are cleaned in bounded maintenance');
select is((select count(*) from private.drawing_preview_project_usage where day < (clock_timestamp() at time zone 'UTC')::date - 2), 0::bigint, 'Old project ledgers are cleaned too');

-- Prior-day exhaustion does not charge the next UTC day.
delete from private.drawing_preview_global_usage where day = (clock_timestamp() at time zone 'UTC')::date;
delete from private.drawing_preview_project_usage where day = (clock_timestamp() at time zone 'UTC')::date;
insert into private.drawing_preview_global_usage(day, attempts) values ((clock_timestamp() at time zone 'UTC')::date - 1, 500);
insert into private.drawing_preview_project_usage(project_id, day, attempts) values
  ('aaaaaaaa-0000-4000-8000-000000000001', (clock_timestamp() at time zone 'UTC')::date - 1, 100);
update private.drawing_preview_jobs set due_at = clock_timestamp() + interval '1 day';
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second', last_started_at = clock_timestamp() - interval '11 seconds'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000001';
insert into preview_claims values ('new-utc-day', public.claim_drawing_preview_job());
select ok((select job is not null from preview_claims where name = 'new-utc-day'), 'Yesterday exhaustion does not block today');
select is((select attempts from private.drawing_preview_global_usage where day = (clock_timestamp() at time zone 'UTC')::date), 1, 'The new day starts a fresh exact global counter');
select public.release_drawing_preview_lease((job ->> 'file_id')::uuid, (job ->> 'lease_token')::uuid) from preview_claims where name = 'new-utc-day';

create temporary table requests_before_drawing_wake as select count(*) as n from net.http_request_queue;
select private.wake_drawing_previews();
select is((select count(*) from net.http_request_queue), (select n from requests_before_drawing_wake), 'Without Vault configuration the scheduler sends nothing');
select public.defer_drawing_preview_dispatch();
select ok((select not_before > clock_timestamp() + interval '298 seconds' from private.drawing_preview_dispatch), 'Missing renderer configuration can pause dispatch for five minutes');
select throws_ok($$select public.defer_drawing_preview_dispatch(3601)$$, '22023',
  'The drawing preview dispatch delay must be between 5 and 3600 seconds', 'The dispatch delay is bounded');

-- Fake credentials stay inside this rolled-back transaction: pg_net cannot
-- send these queue entries before commit, and this test never commits.
select vault.create_secret('https://preview.invalid', 'project_url');
select vault.create_secret('test-only-not-a-real-secret', 'embed_secret_key');
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second', last_started_at = clock_timestamp() - interval '11 seconds';
select private.wake_drawing_previews();
select is((select count(*) from net.http_request_queue), (select n from requests_before_drawing_wake), 'Dispatch cooldown suppresses requests even with Vault configured');
update private.drawing_preview_dispatch set not_before = clock_timestamp() - interval '1 second';
update private.drawing_preview_global_usage set attempts = 500 where day = (clock_timestamp() at time zone 'UTC')::date;
select private.wake_drawing_previews();
select is((select count(*) from net.http_request_queue), (select n from requests_before_drawing_wake), 'A global daily cap suppresses HTTP dispatch entirely');
update private.drawing_preview_global_usage set attempts = 499 where day = (clock_timestamp() at time zone 'UTC')::date;
insert into private.drawing_preview_project_usage(project_id, day, attempts)
  select id, (clock_timestamp() at time zone 'UTC')::date, 100 from public.projects
  on conflict (project_id, day) do update set attempts = 100;
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second';
select private.wake_drawing_previews();
select is((select count(*) from net.http_request_queue), (select n from requests_before_drawing_wake), 'All projects exhausted suppresses HTTP dispatch too');
update private.drawing_preview_project_usage set attempts = 99 where project_id = 'aaaaaaaa-0000-4000-8000-000000000001' and day = (clock_timestamp() at time zone 'UTC')::date;
update private.drawing_preview_jobs set due_at = clock_timestamp() - interval '1 second'
  where file_id = 'aaaaaaaa-1000-4000-8000-000000000001';
select private.wake_drawing_previews();
select is((select count(*) from net.http_request_queue), (select n from requests_before_drawing_wake) + 1, 'Eligible work sends one wake request without claiming or charging attempts');
select is((select url from net.http_request_queue order by id desc limit 1),
  'https://preview.invalid/functions/v1/drawing-previews', 'The existing Vault project URL selects the worker endpoint');
select is((select headers ->> 'apikey' from net.http_request_queue order by id desc limit 1),
  'test-only-not-a-real-secret', 'Wake reuses the existing Vault embed secret, without a new credential');

select * from finish();
rollback;
