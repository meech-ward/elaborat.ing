-- Hybrid search: who can read passages, what gets queued for the embed
-- function, and that a search returns ranked passages from the caller's
-- projects only.
-- Run with the Supabase CLI: `supabase test db` (pgTAP). Everything happens in
-- one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(25);

select table_privs_are('public', 'file_passages', 'anon', array[]::text[], 'Anonymous users cannot touch passages');
select table_privs_are('public', 'file_passages', 'authenticated', array['SELECT'], 'Signed-in users can only read passages');
select policies_are('public', 'file_passages', array['People can read passages in their projects'], 'One policy: people read passages in their projects');
select function_privs_are(
  'public', 'hybrid_search', array['text', 'extensions.vector', 'integer', 'double precision', 'double precision', 'integer'],
  'anon', array[]::text[], 'Anonymous users cannot search'
);
select function_privs_are(
  'private', 'process_file_passages', array['integer', 'integer', 'integer'], 'authenticated', array[]::text[],
  'Signed-in users cannot send jobs to the embed function'
);
select function_privs_are('private', 'queue_file_passages', array[]::text[], 'authenticated', array[]::text[], 'Signed-in users cannot call the queueing trigger');
select isnt_empty($$select 1 from cron.job where jobname = 'process-file-passages' and schedule = '10 seconds'$$, 'pg_cron sends queued files every 10 seconds');

-- A one-hot unit vector: two passages are nearest when they share the dimension.
create function pg_temp.unit(dimension integer)
returns extensions.vector
language sql
immutable
as $$
  select array_agg(case when i = dimension then 1 else 0 end order by i)::real[]::extensions.vector
  from generate_series(1, 384) as i
$$;

-- Alice and Bob each own a project, and Bob has shared his with Alice. Carol
-- owns a project she shared with no one; Dave was invited to it but has not
-- accepted.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'dave@example.com');

insert into public.projects (id, owner_id, title) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Alice'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Bob'),
  ('cccccccc-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'Carol');

insert into public.project_members (project_id, user_id, role, accepted_at) values
  ('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'viewer', now()),
  ('cccccccc-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'viewer', null);

create temporary table queued_before as select count(*) as n from pgmq.q_file_passages;

-- Saving notes and diagrams queues them; drawings and other files are not searched.
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1111-4000-8000-000000000001',
    '[{"op":"put","path":"sauce.md","content":"# Tomato sauce\nSlow simmered tomato sauce for pasta."},
      {"op":"put","path":"garden.mdx","content":"# Garden\nPlanting basil next to peppers."},
      {"op":"put","path":"flow.d2","content":"a -> b"},
      {"op":"put","path":"sketch.excalidraw","content":"{}"},
      {"op":"put","path":"obsidian.excalidraw.md","content":"# drawing"},
      {"op":"put","path":"flow.d2.json","content":"{}"}]') ->> 'status',
  'saved',
  'Alice saves notes, a diagram and other files'
);
reset role;

select is(
  (select count(*) from pgmq.q_file_passages) - (select n from queued_before),
  3::bigint,
  'Only the notes and the diagram are queued'
);
select set_eq(
  $$select f.path from pgmq.q_file_passages q join public.project_files f on f.id = (q.message ->> 'fileId')::uuid
    where f.project_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  array['sauce.md', 'garden.mdx', 'flow.d2'],
  'Each queued job names a saved note or diagram'
);

-- Without the project URL and the function's key in Vault, nothing is sent.
select is(
  (select count(*) from vault.decrypted_secrets where name in ('project_url', 'embed_secret_key')),
  0::bigint,
  'This project has no embed secrets in Vault yet'
);
create temporary table requests_before as select count(*) as n from net.http_request_queue;
select private.process_file_passages();
select is(
  (select count(*) from net.http_request_queue) - (select n from requests_before),
  0::bigint,
  'Without the secrets, processing sends no request'
);
select is(
  (select count(*) from pgmq.q_file_passages where read_ct > 0),
  0::bigint,
  'and reads no job, so each stays ready for the next run'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is(
  public.save_files('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-1111-4000-8000-000000000001',
    '[{"op":"put","path":"quick.md","content":"# Sauce\nA quick tomato sauce."}]') ->> 'status',
  'saved',
  'Bob saves a note in his shared project'
);
set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select is(
  public.save_files('cccccccc-0000-4000-8000-000000000001', 'cccccccc-1111-4000-8000-000000000001',
    '[{"op":"put","path":"secret.md","content":"# Secret tomato sauce\nCarol''s tomato sauce."}]') ->> 'status',
  'saved',
  'Carol saves a note in her own project'
);
reset role;

-- The embed function would write these. Carol's passage matches the query as
-- well as Alice's does, in words and in meaning, and must still never show.
insert into public.file_passages (file_id, project_id, ordinal, headings, content, start_offset, end_offset, embedding)
select f.id, f.project_id, 0, p.headings, p.content, 0, length(f.content), pg_temp.unit(p.dimension)
from (values
  ('sauce.md', 'Tomato sauce', 'Slow simmered tomato sauce for pasta.', 1),
  ('garden.mdx', 'Garden', 'Planting basil next to peppers.', 2),
  ('quick.md', 'Sauce', 'A quick tomato sauce.', 3),
  ('secret.md', 'Secret tomato sauce', 'Carol''s tomato sauce.', 1)
) as p (path, headings, content, dimension)
join public.project_files f on f.path = p.path
  and f.project_id in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001');

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select results_eq(
  $$select path from public.hybrid_search('tomato sauce', pg_temp.unit(1), 10)$$,
  array['sauce.md', 'quick.md', 'garden.mdx'],
  'Alice finds passages from her project and the one shared with her, best match first'
);
select is(
  (select count(*) from public.hybrid_search('tomato sauce', pg_temp.unit(1), 10) where path = 'secret.md'),
  0::bigint,
  'Carol''s passage never reaches Alice, though it matches in words and meaning'
);
select ok(
  (select bool_and(score > 0) and count(*) = 3 from public.hybrid_search('tomato sauce', pg_temp.unit(1), 10)),
  'Every result has a positive fused score'
);
select results_eq(
  $$select path from public.hybrid_search('basil', pg_temp.unit(2), 1)$$,
  array['garden.mdx'],
  'The match count limits the results'
);
select is(
  (select count(*) from public.file_passages),
  3::bigint,
  'Reading passages directly shows Alice the same three'
);

set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select results_eq(
  $$select path from public.hybrid_search('tomato sauce', pg_temp.unit(1), 10)$$,
  array['secret.md'],
  'Carol finds only her own passage'
);

set local request.jwt.claims to '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}';
select is_empty(
  $$select * from public.hybrid_search('tomato sauce', pg_temp.unit(1), 10)$$,
  'An invitation not yet accepted finds nothing'
);

-- Deleting a file removes its passages.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1111-4000-8000-000000000002',
    format('[{"op":"delete","path":"sauce.md","base_version":%s}]',
      (select version from public.project_files
        where project_id = 'aaaaaaaa-0000-4000-8000-000000000001' and path = 'sauce.md'))::jsonb) ->> 'status',
  'saved',
  'Alice deletes a note'
);
select results_eq(
  $$select path from public.hybrid_search('tomato sauce', pg_temp.unit(1), 10)$$,
  array['quick.md', 'garden.mdx'],
  'Its passages are gone from her results'
);

set local role anon;
select throws_ok(
  $$select * from public.hybrid_search('tomato', pg_temp.unit(1), 10)$$,
  '42501',
  null,
  'Anonymous callers cannot search'
);
reset role;

select * from finish();
rollback;
