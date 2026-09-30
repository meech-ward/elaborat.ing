-- Projects, files, sharing and the agent delete rule.
-- Run with the Supabase CLI: `supabase test db` (pgTAP). Everything happens in
-- one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(73);

-- Clients get SELECT through RLS and nothing else; anon gets nothing.
select table_privs_are('public', 'projects', 'authenticated', array['SELECT'], 'Signed-in users can only select projects');
select table_privs_are('public', 'project_members', 'authenticated', array['SELECT'], 'Signed-in users can only select members');
select table_privs_are('public', 'project_files', 'authenticated', array['SELECT'], 'Signed-in users can only select files');
select table_privs_are('public', 'file_versions', 'authenticated', array[]::text[], 'Signed-in users get no table-wide privileges on file history (see agent_requests.test.sql)');
select table_privs_are('public', 'project_folders', 'authenticated', array['SELECT'], 'Signed-in users can only select folders');
select table_privs_are('public', 'projects', 'anon', array[]::text[], 'Anonymous users get nothing on projects');
select table_privs_are('public', 'project_members', 'anon', array[]::text[], 'Anonymous users get nothing on members');
select table_privs_are('public', 'project_files', 'anon', array[]::text[], 'Anonymous users get nothing on files');
select table_privs_are('public', 'file_versions', 'anon', array[]::text[], 'Anonymous users get nothing on file history');
select table_privs_are('public', 'project_folders', 'anon', array[]::text[], 'Anonymous users get nothing on folders');
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
   where c.oid in ('public.projects'::regclass, 'public.project_members'::regclass, 'public.project_files'::regclass,
                   'public.file_versions'::regclass, 'public.project_folders'::regclass, 'private.save_receipts'::regclass)),
  'Row-level security is enabled on every table'
);

-- Two people. Alice owns a project; Bob starts with no access.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com');

set local role anon;
select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000001', '[]') $$,
  '42501',
  null,
  'Anonymous users cannot call the API functions'
);

-- Alice, in a normal session.
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';

select is(
  public.create_project('aaaaaaaa-0000-4000-8000-000000000001', 'Notes') ->> 'role',
  'owner',
  'A person can create a project and owns it'
);

select is(
  public.create_project('aaaaaaaa-0000-4000-8000-000000000001', 'Notes') ->> 'id',
  'aaaaaaaa-0000-4000-8000-000000000001',
  'Creating the same project id again returns the existing project'
);

select throws_ok(
  $$ insert into public.project_files (project_id, path, content, version)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'direct.md', 'x', 1) $$,
  '42501',
  null,
  'Clients cannot write to tables directly'
);

select is(
  (select set_config('test.first_save', public.save_files(
     'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001',
     '[{"op":"put","path":"notes/a.md","content":"hello"},{"op":"put","path":"notes/b.md","content":"world"},{"op":"mkdir","path":"empty"}]'
   )::text, true))::jsonb ->> 'status',
  'saved',
  'A batch of new files and a folder saves'
);

select results_eq(
  $$ select path collate "default", version from public.project_files order by path $$,
  $$ values ('notes/a.md', 1::bigint), ('notes/b.md', 1::bigint) $$,
  'New files take the new project revision as their version'
);

select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001',
    '[{"op":"put","path":"notes/a.md","content":"hello"},{"op":"put","path":"notes/b.md","content":"world"},{"op":"mkdir","path":"empty"}]')::text,
  current_setting('test.first_save'),
  'Repeating a save with the same mutation id returns exactly the original result'
);

select is(
  (public.read_project('aaaaaaaa-0000-4000-8000-000000000001') ->> 'revision')::int,
  1,
  'A repeated save does not save twice'
);

select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001',
       '[{"op":"put","path":"notes/c.md","content":"other"}]') $$,
  '22023',
  'This mutation id was already used for a different save',
  'Reusing a mutation id for a different save is refused'
);

select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
    '[{"op":"put","path":"notes/a.md","content":"hello again","base_version":1}]') -> 'changes' -> 0 ->> 'version',
  '2',
  'Saving with the current version gives the file the new revision'
);

select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000003',
    '[{"op":"put","path":"notes/a.md","content":"stale edit","base_version":1}]') ->> 'status',
  'conflict',
  'Saving with a stale version is a conflict'
);

select is(
  jsonb_array_length(public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000004',
    '[{"op":"put","path":"notes/b.md","content":"valid edit","base_version":1},{"op":"put","path":"notes/a.md","content":"stale edit","base_version":1}]') -> 'conflicts'),
  1,
  'A batch with one stale change reports that conflict'
);

select results_eq(
  $$ select path collate "default", content, version from public.project_files order by path $$,
  $$ values ('notes/a.md', 'hello again', 2::bigint), ('notes/b.md', 'world', 1::bigint) $$,
  'A batch with any conflict writes nothing, including its valid changes'
);

select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000005',
    '[{"op":"put","path":"notes/b.md","content":"new"}]') -> 'conflicts' -> 0 -> 'current' ->> 'content',
  'world',
  'Creating a path that already exists is a conflict that returns the current content'
);

select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000006',
    '[{"op":"put","path":"notes/b.md","content":"world!","base_version":1}]') ->> 'status',
  'saved',
  'An edit to a different file is not a conflict, even after other files changed'
);

select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000007',
    '[{"op":"move","path":"notes/b.md","to":"archive/b.md","base_version":3}]') -> 'changes' -> 0 ->> 'version',
  '4',
  'Moving a file keeps it and gives it the new revision'
);

select is(
  (select count(*)::int from public.file_versions v
     join public.project_files f on f.id = v.file_id
   where f.path = 'archive/b.md'),
  3,
  'File history keeps every version of a moved file'
);

select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000008',
    '[{"op":"delete","path":"archive/b.md","base_version":4}]') ->> 'status',
  'saved',
  'Deleting a file with its current version saves'
);

select ok(
  exists (select 1 from public.file_versions where path = 'archive/b.md' and deleted and content is null and version = 5),
  'A deleted file stays recoverable in its history'
);

select is(
  (public.read_project('aaaaaaaa-0000-4000-8000-000000000001') ->> 'content_bytes'),
  null,
  'read_project does not expose internal accounting'
);

select is(
  (select content_bytes::int from public.projects),
  11,
  'The project tracks the total size of its files'
);

-- A different file at the same path can never be mistaken for the stale one.
select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000009',
    '[{"op":"put","path":"todo.md","content":"first list"}]') -> 'changes' -> 0 ->> 'version',
  '6',
  'A new file takes the new revision'
);

select lives_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000010',
       '[{"op":"move","path":"todo.md","to":"done/todo.md","base_version":6}]') $$,
  'Someone moves the file away'
);

select lives_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000011',
       '[{"op":"put","path":"todo.md","content":"second list"}]') $$,
  'Someone creates a new file at the old path'
);

select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000012',
    '[{"op":"put","path":"todo.md","content":"edit of the first list","base_version":6}]') ->> 'status',
  'conflict',
  'An edit based on the moved file conflicts instead of overwriting the new file'
);

select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000013',
       '[{"op":"put","path":"notes/a.md/inner.md","content":"x"}]') $$,
  '23505',
  'Path is already used by a file or folder: notes/a.md/inner.md',
  'A file cannot contain other files'
);

select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000014',
       '[{"op":"mkdir","path":"notes/a.md"}]') $$,
  '23505',
  null,
  'A folder cannot share a path with a file'
);

select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000015',
       '[{"op":"put","path":"../escape.md","content":"x"}]') $$,
  '22023',
  null,
  'Paths with dot segments are refused'
);

select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000016',
       '[{"op":"put","path":"café.md","content":"x"}]') $$,
  '22023',
  null,
  'Paths that are not NFC-normalized are refused'
);

select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000017',
       '[{"path":"empty"}]') $$,
  '22023',
  'Unknown change op: (missing)',
  'A change without an op is refused, never treated as a folder removal'
);

select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000018',
    '[{"op":"move","path":"done/todo.md","to":"done/first-list.md","content":"first list, moved","base_version":7}]') -> 'changes' -> 0 ->> 'version',
  '9',
  'A move can carry new content in the same change'
);

select is(
  (select content from public.project_files where path = 'done/first-list.md'),
  'first list, moved',
  'The moved file has the new content'
);

select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000019',
       '[{"op":"move","path":"done/first-list.md","to":"done/x.md","content":5,"base_version":9}]') $$,
  '22023',
  'move content must be a string: done/first-list.md',
  'Move content must be a string'
);

-- Bob, with no access yet.
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';

select is((select count(*)::int from public.projects), 0, 'Another person cannot see the project');
select is((select count(*)::int from public.project_files), 0, 'Another person cannot see its files');
select is((select count(*)::int from public.file_versions), 0, 'Another person cannot see its file history');
select is((select count(*)::int from public.project_folders), 0, 'Another person cannot see its folders');
select is((select count(*)::int from public.project_members), 0, 'Another person cannot see its members');

select is(
  public.read_project('aaaaaaaa-0000-4000-8000-000000000001'),
  null,
  'Another person cannot read the project'
);

select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001',
       '[{"op":"put","path":"intrude.md","content":"x"}]') $$,
  '42501',
  null,
  'Another person cannot save to the project'
);

select throws_ok(
  $$ select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'editor') $$,
  '42501',
  null,
  'Only the owner can share'
);

-- Alice invites Bob as a viewer.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok(
  $$ select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'viewer') $$,
  'The owner can invite someone as viewer'
);

set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';

select is((select count(*)::int from public.projects), 0, 'An invitation grants no access until it is accepted');

select is(
  public.list_invitations() -> 0 ->> 'title',
  'Notes',
  'The invited person sees the invitation with the project title'
);

-- Bob's agent tries to accept for him.
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","client_id":"agent-client"}';
select throws_ok(
  $$ select public.accept_invitation('aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501',
  'Only a signed-in person can accept an invitation',
  'An agent cannot accept an invitation'
);

set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is(
  public.accept_invitation('aaaaaaaa-0000-4000-8000-000000000001') ->> 'role',
  'viewer',
  'The invited person can accept'
);

select is((select count(*)::int from public.project_files), 3, 'A viewer can read the files');

select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002',
       '[{"op":"put","path":"viewer.md","content":"x"}]') $$,
  '42501',
  'Changing this project needs editor access',
  'A viewer cannot save'
);

-- Alice makes Bob an editor.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok(
  $$ select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'editor') $$,
  'The owner can change a member to editor'
);

-- Bob, connected as an agent (an OAuth client token).
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","client_id":"agent-client"}';

select is(
  (select set_config('test.agent_save', public.save_files(
     'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003',
     '[{"op":"put","path":"notes/from-agent.md","content":"hi"}]'
   )::text, true))::jsonb ->> 'status',
  'saved',
  'An editor connected as an agent can save'
);

select is(
  public.archive_project('aaaaaaaa-0000-4000-8000-000000000001') ->> 'archived_at' is not null,
  true,
  'An agent can archive a project'
);

select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000004',
       '[{"op":"put","path":"notes/late.md","content":"x"}]') $$,
  '55000',
  'Project is archived',
  'An archived project cannot be changed'
);

select is(
  public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003',
    '[{"op":"put","path":"notes/from-agent.md","content":"hi"}]')::text,
  current_setting('test.agent_save'),
  'Retrying a save that already happened still returns its result after archiving'
);

select is(
  public.unarchive_project('aaaaaaaa-0000-4000-8000-000000000001') ->> 'archived_at',
  null,
  'An agent can unarchive a project'
);

-- Alice's own agent cannot permanently delete, even though Alice owns the project.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","client_id":"agent-client"}';
select throws_ok(
  $$ select public.delete_project('aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501',
  'Only a signed-in person can permanently delete a project; agents can archive it',
  'An agent cannot permanently delete, even for the owner'
);

-- Bob, as a person, is an editor but not the owner.
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select throws_ok(
  $$ select public.delete_project('aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501',
  'Only the project owner can permanently delete it',
  'An editor cannot permanently delete'
);

-- Alice removes Bob.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok(
  $$ select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', null) $$,
  'The owner can remove a member'
);

set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.projects), 0, 'A removed member cannot see the project');
select is((select count(*)::int from public.file_versions), 0, 'A removed member cannot see its file history');
select throws_ok(
  $$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000005',
       '[{"op":"put","path":"after-removal.md","content":"x"}]') $$,
  '42501',
  null,
  'A removed member cannot save'
);
select throws_ok(
  $$ select public.leave_project('aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501',
  'You are not a member of this project',
  'Leaving a project you are not in is refused'
);

-- Alice, as a person.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(
  public.delete_project('aaaaaaaa-0000-4000-8000-000000000001') ->> 'deleted',
  'true',
  'The owner can permanently delete in a normal session'
);

select * from finish();
rollback;
