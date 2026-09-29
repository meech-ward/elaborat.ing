-- Comments: who can read and write them, people and agents, and what they
-- survive. Run with the Supabase CLI: `supabase test db` (pgTAP). Everything
-- happens in one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(196);

-- People, by name. Alice owns the project; Bob is an editor, Carol a
-- commenter, Dave a viewer and Gina a commenter, all accepted. Erin has a
-- commenter invitation she has not accepted; Frank has nothing to do with it.
create function pg_temp.id(who text)
returns uuid
language sql
immutable
as $$
  select (case who
    when 'alice' then '11111111-1111-4111-8111-111111111111'
    when 'bob' then '22222222-2222-4222-8222-222222222222'
    when 'carol' then '33333333-3333-4333-8333-333333333333'
    when 'dave' then '44444444-4444-4444-8444-444444444444'
    when 'erin' then '55555555-5555-4555-8555-555555555555'
    when 'frank' then '66666666-6666-4666-8666-666666666666'
    when 'gina' then '77777777-7777-4777-8777-777777777777'
  end)::uuid
$$;

-- Act as someone, in a person session or through their agent (an OAuth client token).
create function pg_temp.act(who text, agent boolean default false)
returns void
language sql
as $$
  select set_config(
    'request.jwt.claims',
    (jsonb_build_object('sub', pg_temp.id(who), 'role', 'authenticated')
      || case when agent then jsonb_build_object('client_id', 'agent-client') else '{}'::jsonb end)::text,
    true
  )
$$;

-- Projects: P is the shared one, O is Frank's own, S is Alice's for counting signals.
create function pg_temp.project(name text)
returns uuid
language sql
immutable
as $$
  select (case name
    when 'P' then 'aaaaaaaa-0000-4000-8000-000000000001'
    when 'O' then 'bbbbbbbb-0000-4000-8000-000000000001'
    when 'S' then 'cccccccc-0000-4000-8000-000000000001'
  end)::uuid
$$;

-- Files by name, thread ids and reply ids by number.
create function pg_temp.file(name text)
returns uuid
language sql
immutable
as $$
  select (case name
    when 'a' then 'f0000000-0000-4000-8000-00000000000a'
    when 'b' then 'f0000000-0000-4000-8000-00000000000b'
    when 'drawing' then 'f0000000-0000-4000-8000-00000000000d'
    when 'busy' then 'f0000000-0000-4000-8000-0000000000bb'
    when 'other' then 'f0000000-0000-4000-8000-000000000009'
    when 's' then 'f0000000-0000-4000-8000-000000000005'
  end)::uuid
$$;

create function pg_temp.t(n integer)
returns uuid
language sql
immutable
as $$ select ('c0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

create function pg_temp.r(n integer)
returns uuid
language sql
immutable
as $$ select ('c1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

-- One anchor of each kind, as the app describes them.
create function pg_temp.anchor(kind text)
returns jsonb
language sql
immutable
as $$
  select case kind
    when 'document' then '{"kind": "document"}'::jsonb
    when 'text' then '{"kind": "text",
      "quote": {"type": "TextQuoteSelector", "exact": "Some text", "prefix": "# Guide\n\n", "suffix": " here."},
      "position": {"type": "TextPositionSelector", "start": 9, "end": 18}}'::jsonb
    when 'section' then '{"kind": "section",
      "quote": {"type": "TextQuoteSelector", "exact": "# Guide", "prefix": "", "suffix": "\n\nSome text here."},
      "position": {"type": "TextPositionSelector", "start": 0, "end": 7}}'::jsonb
    when 'element' then '{"kind": "element", "element_id": "box-1", "label": "rectangle", "point": {"x": 0.25, "y": 1}}'::jsonb
  end
$$;

-- A comment's id in a thread, by its author.
create function pg_temp.comment_by(thread uuid, who text)
returns uuid
language sql
as $$
  select c.id from public.comments c where c.thread_id = thread and c.author_id = pg_temp.id(who) limit 1
$$;

-- A thread as the caller lists it, or null.
create function pg_temp.listed(project uuid, thread uuid)
returns jsonb
language sql
as $$
  select t from jsonb_array_elements(public.list_comments(project) -> 'threads') t where t ->> 'id' = thread::text
$$;

create function pg_temp.revision(project uuid)
returns bigint
language sql
as $$ select revision from public.projects where id = project $$;

-- How much a statement raises a project's revision.
create function pg_temp.revision_change(project uuid, statement text)
returns bigint
language plpgsql
as $$
declare
  before bigint;
begin
  select revision into before from public.projects where id = project;
  execute statement;
  return (select revision from public.projects where id = project) - before;
end;
$$;

-- The detail of the error a statement raises.
create function pg_temp.error_detail(statement text)
returns text
language plpgsql
as $$
declare
  detail text;
begin
  execute statement;
  return null;
exception when others then
  get stacked diagnostics detail = pg_exception_detail;
  return detail;
end;
$$;

-- Put a user's count for a limit at `uses` in the current window.
create function pg_temp.set_uses(who uuid, limit_name text, uses integer)
returns void
language sql
as $$
  insert into private.limit_counters (user_id, name, window_start, uses)
  select who, limit_name, date_bin(l.window_length, now(), timestamptz '2000-01-01 00:00:00+00'), uses
  from private.limits() l where l.name = limit_name
  on conflict (user_id, name) do update set window_start = excluded.window_start, uses = excluded.uses
$$;

------------------------------------------------------------------------------
-- Grants and RLS.

select table_privs_are('public', 'comment_threads', 'authenticated', array['SELECT'], 'Signed-in users can only select comment threads');
select table_privs_are('public', 'comments', 'authenticated', array[]::text[], 'Signed-in users get no table-wide privileges on comments');
select is(
  (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
   where a.attrelid = 'public.comments'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.comments', a.attname, 'select')),
  array['id', 'thread_id', 'project_id', 'author_id', 'body', 'created_at', 'edited_at', 'deleted_at'],
  'Signed-in users select every comment column except the agent''s OAuth client'
);
select is(
  (select count(*)::int from pg_attribute a
   where a.attrelid = 'public.comments'::regclass and a.attnum > 0 and not a.attisdropped
     and (has_column_privilege('authenticated', 'public.comments', a.attname, 'insert, update, references')
          or has_column_privilege('anon', 'public.comments', a.attname, 'select, insert, update, references'))),
  0,
  'and nothing else on any column'
);
select table_privs_are('private', 'deleted_comment_threads', 'authenticated', array[]::text[], 'Signed-in users get nothing on deleted thread ids');
select table_privs_are('private', 'deleted_comment_threads', 'anon', array[]::text[], 'Anonymous users get nothing on deleted thread ids');
select table_privs_are('public', 'comment_threads', 'anon', array[]::text[], 'Anonymous users get nothing on comment threads');
select table_privs_are('public', 'comments', 'anon', array[]::text[], 'Anonymous users get nothing on comments');
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
   where c.oid in ('public.comment_threads'::regclass, 'public.comments'::regclass)),
  'Row-level security is enabled on both comment tables'
);
select policies_are('public', 'comment_threads', array['People can read comment threads in their projects'], 'Threads have one read policy');
select policies_are('public', 'comments', array['People can read comments in their projects'], 'Comments have one read policy');

select function_privs_are('public', 'list_comments', array['uuid', 'uuid'], 'authenticated', array['EXECUTE'], 'Signed-in users can list comments');
select function_privs_are('public', 'list_comments', array['uuid', 'uuid'], 'anon', array[]::text[], 'Anonymous users cannot list comments');
select function_privs_are('public', 'add_comment', array['uuid', 'uuid', 'uuid', 'bigint', 'jsonb', 'text'], 'authenticated', array['EXECUTE'], 'Signed-in users can add comments');
select function_privs_are('public', 'add_comment', array['uuid', 'uuid', 'uuid', 'bigint', 'jsonb', 'text'], 'anon', array[]::text[], 'Anonymous users cannot add comments');
select function_privs_are('public', 'reply_comment', array['uuid', 'uuid', 'text'], 'authenticated', array['EXECUTE'], 'Signed-in users can reply');
select function_privs_are('public', 'reply_comment', array['uuid', 'uuid', 'text'], 'anon', array[]::text[], 'Anonymous users cannot reply');
select function_privs_are('public', 'edit_comment', array['uuid', 'text'], 'authenticated', array['EXECUTE'], 'Signed-in users can edit comments');
select function_privs_are('public', 'edit_comment', array['uuid', 'text'], 'anon', array[]::text[], 'Anonymous users cannot edit comments');
select function_privs_are('public', 'resolve_comment', array['uuid'], 'authenticated', array['EXECUTE'], 'Signed-in users can resolve threads');
select function_privs_are('public', 'resolve_comment', array['uuid'], 'anon', array[]::text[], 'Anonymous users cannot resolve threads');
select function_privs_are('public', 'reopen_comment', array['uuid'], 'authenticated', array['EXECUTE'], 'Signed-in users can reopen threads');
select function_privs_are('public', 'reopen_comment', array['uuid'], 'anon', array[]::text[], 'Anonymous users cannot reopen threads');
select function_privs_are('public', 'delete_comment', array['uuid'], 'authenticated', array['EXECUTE'], 'Signed-in users can delete comments');
select function_privs_are('public', 'delete_comment', array['uuid'], 'anon', array[]::text[], 'Anonymous users cannot delete comments');
select function_privs_are('public', 'delete_comment_thread', array['uuid'], 'authenticated', array['EXECUTE'], 'Signed-in users can delete threads');
select function_privs_are('public', 'delete_comment_thread', array['uuid'], 'anon', array[]::text[], 'Anonymous users cannot delete threads');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname in ('is_valid_comment_anchor', 'lock_project_for_comment', 'comment_project', 'check_comment_body',
                       'list_comments', 'add_comment', 'reply_comment', 'edit_comment', 'set_comment_resolved',
                       'delete_comment', 'delete_comment_thread')
     and has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('anon', p.oid, 'execute')),
  11,
  'Signed-in users, and not anonymous ones, can call the private comment functions, which check the caller themselves'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname in ('person_name', 'comment_person', 'comment_json', 'thread_json')
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  0,
  'Nobody can call the helpers that read account emails, except the functions that checked access first'
);

------------------------------------------------------------------------------
-- The people, projects and files.

insert into auth.users (id, email)
select pg_temp.id(name), name || '@example.com'
from unnest(array['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina']) name;

insert into public.projects (id, owner_id, title, revision) values
  (pg_temp.project('P'), pg_temp.id('alice'), 'Shared', 1),
  (pg_temp.project('O'), pg_temp.id('frank'), 'Frank''s', 1),
  (pg_temp.project('S'), pg_temp.id('alice'), 'Signals', 1);

insert into public.project_members (project_id, user_id, role, accepted_at) values
  (pg_temp.project('P'), pg_temp.id('bob'), 'editor', now()),
  (pg_temp.project('P'), pg_temp.id('carol'), 'commenter', now()),
  (pg_temp.project('P'), pg_temp.id('dave'), 'viewer', now()),
  (pg_temp.project('P'), pg_temp.id('gina'), 'commenter', now()),
  (pg_temp.project('P'), pg_temp.id('erin'), 'commenter', null);

insert into public.project_files (id, project_id, path, content, version, updated_by) values
  (pg_temp.file('a'), pg_temp.project('P'), 'notes/a.md', E'# Guide\n\nSome text here.\n', 1, pg_temp.id('alice')),
  (pg_temp.file('b'), pg_temp.project('P'), 'notes/b.md', 'B', 1, pg_temp.id('alice')),
  (pg_temp.file('drawing'), pg_temp.project('P'), 'drawing.excalidraw', '{"type":"excalidraw","elements":[]}', 1, pg_temp.id('alice')),
  (pg_temp.file('busy'), pg_temp.project('P'), 'notes/busy.md', 'Busy', 1, pg_temp.id('alice')),
  (pg_temp.file('other'), pg_temp.project('O'), 'other.md', 'Other', 1, pg_temp.id('frank')),
  (pg_temp.file('s'), pg_temp.project('S'), 's.md', 'S', 1, pg_temp.id('alice'));

insert into public.file_versions (file_id, version, project_id, path, content, author_id, mutation_id)
select f.id, f.version, f.project_id, f.path, f.content, f.updated_by, gen_random_uuid()
from public.project_files f
where f.project_id in (pg_temp.project('P'), pg_temp.project('O'), pg_temp.project('S'));

update public.projects p
set content_bytes = (select sum(octet_length(f.content)) from public.project_files f where f.project_id = p.id)
where p.id in (pg_temp.project('P'), pg_temp.project('O'), pg_temp.project('S'));

------------------------------------------------------------------------------
-- Starting threads, by role.

set local role anon;
select throws_ok(
  $$ select public.list_comments('aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501', null, 'Anonymous users cannot list comments'
);

set local role authenticated;
select pg_temp.act('alice');
select is(
  public.add_comment(pg_temp.project('P'), pg_temp.t(1), pg_temp.file('a'), 1, pg_temp.anchor('text'), 'Is this still true?') #> '{thread,path}',
  '"notes/a.md"',
  'The owner starts a thread on a text selection'
);
select pg_temp.act('bob');
select is(
  public.add_comment(pg_temp.project('P'), pg_temp.t(2), pg_temp.file('b'), 1, pg_temp.anchor('document'), 'Whole file') #> '{thread,anchor}',
  '{"kind": "document"}',
  'An editor starts a thread on a whole file'
);
select pg_temp.act('carol');
select is(
  public.add_comment(pg_temp.project('P'), pg_temp.t(3), pg_temp.file('drawing'), 1, pg_temp.anchor('element'), 'This box') #> '{thread,anchor,element_id}',
  '"box-1"',
  'A commenter starts a thread on a drawing element'
);
select pg_temp.act('dave');
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '42501', 'Commenting needs commenter access', 'A viewer cannot start a thread'
);
select pg_temp.act('erin');
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '42501', 'Project unavailable', 'Someone with a pending invitation cannot start a thread'
);
select pg_temp.act('frank');
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '42501', 'Project unavailable', 'An outsider cannot start a thread'
);

-- The shape of a listed thread and comment.
select pg_temp.act('dave');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pg_temp.listed(pg_temp.project('P'), pg_temp.t(1))) k),
  array['anchor', 'comments', 'created_at', 'file_deleted', 'file_id', 'file_version', 'id', 'path', 'resolved_at', 'resolved_by'],
  'A thread lists its id, file, path, anchor, times, resolution and comments'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pg_temp.listed(pg_temp.project('P'), pg_temp.t(1)) #> '{comments,0}') k),
  array['author', 'body', 'created_at', 'deleted_at', 'edited_at', 'id', 'via_agent'],
  'A comment lists its id, author, whether an agent wrote it, body and times'
);
select is(
  pg_temp.listed(pg_temp.project('P'), pg_temp.t(1)) - 'created_at' - 'comments',
  jsonb_build_object(
    'id', pg_temp.t(1), 'file_id', pg_temp.file('a'), 'path', 'notes/a.md', 'file_deleted', false,
    'file_version', 1, 'anchor', pg_temp.anchor('text'), 'resolved_at', null, 'resolved_by', null
  ),
  'A viewer reads the thread with its anchor exactly as it was stored'
);
select is(
  (pg_temp.listed(pg_temp.project('P'), pg_temp.t(1)) #> '{comments,0}') - 'id' - 'created_at',
  jsonb_build_object(
    'author', jsonb_build_object('user_id', pg_temp.id('alice'), 'email', 'alice@example.com', 'name', 'alice@example.com'),
    'via_agent', false, 'body', 'Is this still true?', 'edited_at', null, 'deleted_at', null
  ),
  'The opening comment names its author by id, email and name (the email, when they have no name)'
);

-- Names: the one a person set in Settings, else their sign-in provider's, else their email.
reset role;
update auth.users set raw_user_meta_data = '{"full_name": "Bob Builder", "name": "bob"}' where id = pg_temp.id('bob');
update auth.users set raw_user_meta_data = '{"display_name": "  Carol \n  C  ", "full_name": "Caroline"}' where id = pg_temp.id('carol');
select is(private.person_name('{"display_name": "Gina", "full_name": "Regina G", "name": "regina"}', 'g@example.com'), 'Gina', 'A name set in Settings comes first');
select is(private.person_name('{"full_name": "Regina G", "name": "regina"}', 'g@example.com'), 'Regina G', 'then the full name a provider gave');
select is(private.person_name('{"name": "regina"}', 'g@example.com'), 'regina', 'then its name');
select is(private.person_name('{"display_name": "  ", "full_name": ""}', 'g@example.com'), 'g@example.com', 'A blank name falls back to the email');
select is(private.person_name('{}', null), null, 'No name and no email is null');
select is(private.person_name(jsonb_build_object('display_name', repeat('x', 100)), 'g@example.com'), repeat('x', 80), 'A name is cut to 80 characters');
set local role authenticated;
select pg_temp.act('dave');
select is(
  (select jsonb_agg(jsonb_build_array(t #>> '{comments,0,author,email}', t #>> '{comments,0,author,name}') order by t ->> 'id')
   from jsonb_array_elements(public.list_comments(pg_temp.project('P')) -> 'threads') t),
  jsonb_build_array(
    jsonb_build_array('alice@example.com', 'alice@example.com'),
    jsonb_build_array('bob@example.com', 'Bob Builder'),
    jsonb_build_array('carol@example.com', 'Carol C')
  ),
  'Comments name their authors: the name they set, else their provider''s, else their email'
);
select pg_temp.act('dave', true);
select is(
  pg_temp.listed(pg_temp.project('P'), pg_temp.t(2)) #>> '{comments,0,author,name}',
  'Bob Builder',
  'Agents read the names too'
);
select pg_temp.act('dave');
select is(
  (select jsonb_agg(t ->> 'id') from jsonb_array_elements(public.list_comments(pg_temp.project('P'), pg_temp.file('a')) -> 'threads') t),
  jsonb_build_array(pg_temp.t(1)),
  'Listing one file lists only its threads'
);
select is(
  public.list_comments(pg_temp.project('P')) -> 'revision',
  to_jsonb(pg_temp.revision(pg_temp.project('P'))),
  'A list carries the project''s current revision'
);

-- Reading the tables directly.
select pg_temp.act('alice');
select is(array[(select count(*) from public.comment_threads), (select count(*) from public.comments)]::int[], array[3, 3], 'The owner reads every thread and comment');
select pg_temp.act('bob');
select is(array[(select count(*) from public.comment_threads), (select count(*) from public.comments)]::int[], array[3, 3], 'An editor reads them');
select pg_temp.act('carol');
select is(array[(select count(*) from public.comment_threads), (select count(*) from public.comments)]::int[], array[3, 3], 'A commenter reads them');
select pg_temp.act('dave');
select is(array[(select count(*) from public.comment_threads), (select count(*) from public.comments)]::int[], array[3, 3], 'A viewer reads them');
select throws_ok(
  $$ select agent_client_id from public.comments $$,
  '42501', 'permission denied for table comments',
  'but not which OAuth client wrote a comment'
);
select is(
  (select count(*)::int from (
     select id, thread_id, project_id, author_id, body, created_at, edited_at, deleted_at from public.comments
   ) c where c.body is not null),
  3,
  'and reads every other column'
);
select pg_temp.act('erin');
select is(array[(select count(*) from public.comment_threads), (select count(*) from public.comments)]::int[], array[0, 0], 'Someone with a pending invitation reads none');
select throws_ok(
  $$ select public.list_comments(pg_temp.project('P')) $$,
  '42501', 'Project unavailable', 'and cannot list them'
);
select pg_temp.act('frank');
select is(array[(select count(*) from public.comment_threads), (select count(*) from public.comments)]::int[], array[0, 0], 'An outsider reads none');
select throws_ok(
  $$ select public.list_comments(pg_temp.project('P')) $$,
  '42501', 'Project unavailable', 'and cannot list them'
);

------------------------------------------------------------------------------
-- Replies, resolving and reopening.

select pg_temp.act('bob');
select is(
  public.reply_comment(pg_temp.t(1), pg_temp.r(1), 'Yes, still true.') #> '{comment,author,email}',
  '"bob@example.com"',
  'An editor replies'
);
select pg_temp.act('carol');
select is(
  public.reply_comment(pg_temp.t(1), pg_temp.r(2), 'Agreed.') #> '{comment,id}',
  to_jsonb(pg_temp.r(2)),
  'A commenter replies, with the id she chose'
);
select pg_temp.act('dave');
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(1), pg_temp.r(90), 'Hi') $$,
  '42501', 'Commenting needs commenter access', 'A viewer cannot reply'
);
select pg_temp.act('frank');
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(1), pg_temp.r(90), 'Hi') $$,
  '42501', 'Comment unavailable', 'An outsider cannot reply, and learns nothing about the thread'
);
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(99), pg_temp.r(90), 'Hi') $$,
  '42501', 'Comment unavailable', 'A missing thread gives the same answer'
);
select pg_temp.act('erin');
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(1), pg_temp.r(90), 'Hi') $$,
  '42501', 'Comment unavailable', 'Someone with a pending invitation cannot reply'
);

select pg_temp.act('carol');
select is(
  public.resolve_comment(pg_temp.t(1)) #> '{thread,resolved_by,email}',
  '"carol@example.com"',
  'A commenter resolves a thread someone else started'
);
select ok(
  (pg_temp.listed(pg_temp.project('P'), pg_temp.t(1)) ->> 'resolved_at') is not null,
  'and it lists as resolved'
);
select pg_temp.act('bob');
select is(
  (public.reopen_comment(pg_temp.t(1)) -> 'thread') - 'created_at' - 'comments' - 'anchor' - 'file_id' - 'file_version' - 'path' - 'file_deleted',
  jsonb_build_object('id', pg_temp.t(1), 'resolved_at', null, 'resolved_by', null),
  'An editor reopens it'
);
select pg_temp.act('dave');
select throws_ok(
  $$ select public.resolve_comment(pg_temp.t(1)) $$,
  '42501', 'Commenting needs commenter access', 'A viewer cannot resolve a thread'
);
select pg_temp.act('frank');
select throws_ok(
  $$ select public.reopen_comment(pg_temp.t(1)) $$,
  '42501', 'Comment unavailable', 'An outsider cannot reopen a thread'
);

------------------------------------------------------------------------------
-- Agents: everything but deleting.

select pg_temp.act('carol', true);
select is(
  jsonb_array_length(public.list_comments(pg_temp.project('P')) -> 'threads'),
  3,
  'A commenter''s agent lists the threads'
);
select is(
  public.add_comment(pg_temp.project('P'), pg_temp.t(4), pg_temp.file('b'), 1, pg_temp.anchor('document'), 'From the agent') #> '{thread,comments,0,via_agent}',
  'true',
  'Her agent starts a thread, marked as written by an agent'
);
select is(
  public.reply_comment(pg_temp.t(4), pg_temp.r(3), 'Agent reply') #> '{comment,via_agent}',
  'true',
  'Her agent replies'
);
select ok(public.resolve_comment(pg_temp.t(4)) #>> '{thread,resolved_at}' is not null, 'Her agent resolves a thread');
select ok(public.reopen_comment(pg_temp.t(4)) #>> '{thread,resolved_at}' is null, 'and reopens it');
select throws_ok(
  $$ select public.edit_comment(pg_temp.r(2), 'I approve, says my agent.') $$,
  '42501', 'Only a signed-in person can edit comments; agents can reply',
  'Her agent cannot change her words'
);
select throws_ok(
  $$ select public.edit_comment(pg_temp.r(3), 'Agent reply, edited') $$,
  '42501', 'Only a signed-in person can edit comments; agents can reply',
  'nor a comment it wrote itself'
);
select throws_ok(
  $$ select public.delete_comment(pg_temp.r(2)) $$,
  '42501', 'Only a signed-in person can delete comments; agents can resolve them',
  'Her agent cannot delete her own comment'
);
select throws_ok(
  $$ select public.delete_comment_thread(pg_temp.t(4)) $$,
  '42501', 'Only a signed-in person can delete comments; agents can resolve them',
  'nor a thread her agent started'
);
select pg_temp.act('alice', true);
select throws_ok(
  $$ select public.delete_comment(pg_temp.r(2)) $$,
  '42501', 'Only a signed-in person can delete comments; agents can resolve them',
  'The owner''s agent cannot delete someone''s comment'
);
select throws_ok(
  $$ select public.delete_comment_thread(pg_temp.t(4)) $$,
  '42501', 'Only a signed-in person can delete comments; agents can resolve them',
  'The owner''s agent cannot delete a thread'
);
select pg_temp.act('dave', true);
select is(
  jsonb_array_length(public.list_comments(pg_temp.project('P')) -> 'threads'),
  4,
  'A viewer''s agent lists the threads'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '42501', 'Commenting needs commenter access', 'but cannot start one'
);
reset role;
select is(
  (select array_agg(agent_client_id order by id) from public.comments where author_id = pg_temp.id('carol') and agent_client_id is not null),
  array['agent-client', 'agent-client'],
  'The agent''s comments record its OAuth client, from its token'
);
select is(
  (select jsonb_build_object('body', body, 'edited_at', edited_at, 'agent_client_id', agent_client_id)
   from public.comments where id = pg_temp.r(2)),
  '{"body": "Agreed.", "edited_at": null, "agent_client_id": null}',
  'Her comment keeps her words, unedited'
);

------------------------------------------------------------------------------
-- Edits.

set local role authenticated;
select pg_temp.act('carol');
select ok(
  (select c ->> 'body' = 'Agreed, edited.' and c ->> 'edited_at' is not null
   from (select public.edit_comment(pg_temp.r(2), 'Agreed, edited.') -> 'comment' as c) x),
  'The author edits her comment, and it is marked as edited'
);
select is(
  pg_temp.revision_change(pg_temp.project('P'), $$ select public.edit_comment(pg_temp.r(2), 'Agreed, edited.') $$),
  0::bigint,
  'Saving the same words changes nothing'
);
select pg_temp.act('alice');
select throws_ok(
  $$ select public.edit_comment(pg_temp.r(2), 'Owner''s words') $$,
  '42501', 'Only its author can edit a comment', 'The owner cannot edit someone else''s comment'
);
select pg_temp.act('bob');
select throws_ok(
  $$ select public.edit_comment(pg_temp.r(2), 'Editor''s words') $$,
  '42501', 'Only its author can edit a comment', 'An editor cannot either'
);

------------------------------------------------------------------------------
-- Deletes.

select pg_temp.act('carol');
select is(
  public.delete_comment(pg_temp.r(2)) - 'revision',
  jsonb_build_object('comment_id', pg_temp.r(2), 'thread_deleted', false),
  'The author deletes her reply'
);
select is(
  (select jsonb_build_object('body', c -> 'body', 'deleted', c ->> 'deleted_at' is not null, 'author', c #>> '{author,email}')
   from jsonb_array_elements(pg_temp.listed(pg_temp.project('P'), pg_temp.t(1)) -> 'comments') c
   where c ->> 'id' = pg_temp.r(2)::text),
  '{"body": null, "deleted": true, "author": "carol@example.com"}',
  'Its words are gone; a placeholder keeps its author and time'
);
select is(
  pg_temp.revision_change(pg_temp.project('P'), $$ select public.delete_comment(pg_temp.r(2)) $$),
  0::bigint,
  'Deleting it again changes nothing'
);
select throws_ok(
  $$ select public.edit_comment(pg_temp.r(2), 'Back again') $$,
  '22023', 'This comment was deleted', 'A deleted comment cannot be edited'
);
select pg_temp.act('bob');
select throws_ok(
  format('select public.delete_comment(%L)', pg_temp.comment_by(pg_temp.t(1), 'alice')),
  '42501', 'Only its author or the project owner can delete a comment', 'An editor cannot delete someone else''s comment'
);
select pg_temp.act('dave');
select throws_ok(
  format('select public.delete_comment(%L)', pg_temp.comment_by(pg_temp.t(1), 'alice')),
  '42501', 'Commenting needs commenter access', 'A viewer cannot delete a comment'
);
select pg_temp.act('alice');
select is(
  public.delete_comment(pg_temp.comment_by(pg_temp.t(1), 'alice')) -> 'thread_deleted',
  'false',
  'The owner deletes her opening comment while a reply is still there'
);
select is(
  (select jsonb_agg(jsonb_build_array(c #>> '{author,email}', c -> 'body') order by c #>> '{author,email}')
   from jsonb_array_elements(pg_temp.listed(pg_temp.project('P'), pg_temp.t(1)) -> 'comments') c),
  '[["alice@example.com", null], ["bob@example.com", "Yes, still true."], ["carol@example.com", null]]',
  'The thread stays, with placeholders around the reply'
);
select pg_temp.act('bob');
select is(
  public.delete_comment(pg_temp.r(1)) -> 'thread_deleted',
  'true',
  'Deleting the last live comment deletes the thread'
);
select is(
  array[(select count(*) from public.comment_threads where id = pg_temp.t(1)), (select count(*) from public.comments where thread_id = pg_temp.t(1))]::int[],
  array[0, 0],
  'with its placeholders'
);
select pg_temp.act('alice');
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(1), pg_temp.file('a'), 1, pg_temp.anchor('text'), 'Is this still true?') $$,
  '22023', 'This comment was deleted', 'Repeating the add of a deleted thread says it was deleted'
);
select is((select count(*)::int from public.comment_threads where id = pg_temp.t(1)), 0, 'and does not start it again');
select pg_temp.act('bob');
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(1), pg_temp.file('b'), 1, pg_temp.anchor('document'), 'Mine now') $$,
  '22023', 'This comment was deleted', 'nor can anyone else in the project reuse its id'
);

-- Alice can delete Carol's comment; Bob can't.
select is(public.reply_comment(pg_temp.t(3), pg_temp.r(4), 'Bob on the box') #>> '{comment,body}', 'Bob on the box', 'Bob replies on Carol''s drawing thread');
select throws_ok(
  format('select public.delete_comment(%L)', pg_temp.comment_by(pg_temp.t(3), 'carol')),
  '42501', 'Only its author or the project owner can delete a comment', 'An editor cannot delete a commenter''s comment'
);
select pg_temp.act('alice');
select is(
  public.delete_comment(pg_temp.comment_by(pg_temp.t(3), 'carol')) -> 'thread_deleted',
  'false',
  'The owner deletes a commenter''s comment'
);

-- Whole threads.
select pg_temp.act('carol');
select lives_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(5), pg_temp.file('a'), 1, pg_temp.anchor('section'), 'On this section');
     select public.reply_comment(pg_temp.t(5), pg_temp.r(5), 'And more') $$,
  'Carol starts a thread on a section and replies to it herself'
);
select is(
  public.delete_comment_thread(pg_temp.t(5)) - 'revision',
  jsonb_build_object('thread_id', pg_temp.t(5), 'deleted', true),
  'She deletes her own thread when every comment in it is hers'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(5), pg_temp.file('a'), 1, pg_temp.anchor('section'), 'On this section') $$,
  '22023', 'This comment was deleted', 'Repeating the add of a thread deleted whole says it was deleted too'
);
select lives_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(6), pg_temp.file('a'), 1, pg_temp.anchor('document'), 'Carol asks') $$,
  'Carol starts another thread'
);
select pg_temp.act('bob');
select lives_ok($$ select public.reply_comment(pg_temp.t(6), pg_temp.r(6), 'Bob answers') $$, 'Bob replies to it');
select throws_ok(
  $$ select public.delete_comment_thread(pg_temp.t(6)) $$,
  '42501', 'Only the project owner can delete a thread with other people''s comments', 'Bob cannot delete a thread he did not start'
);
select pg_temp.act('carol');
select throws_ok(
  $$ select public.delete_comment_thread(pg_temp.t(6)) $$,
  '42501', 'Only the project owner can delete a thread with other people''s comments', 'Carol cannot delete her thread once Bob replied'
);
select pg_temp.act('dave');
select throws_ok(
  $$ select public.delete_comment_thread(pg_temp.t(6)) $$,
  '42501', 'Commenting needs commenter access', 'A viewer cannot delete a thread'
);
select pg_temp.act('alice');
select is(
  public.delete_comment_thread(pg_temp.t(6)) -> 'deleted',
  'true',
  'The owner deletes any thread'
);

------------------------------------------------------------------------------
-- Validation, and retries.

select pg_temp.act('carol');
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1, '{"kind": "page"}', 'Hi') $$,
  '22023', 'Invalid anchor', 'An unknown anchor kind is refused'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1, '{"kind": "document", "note": 1}', 'Hi') $$,
  '22023', 'Invalid anchor', 'An anchor with an extra key is refused'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1,
       jsonb_set(pg_temp.anchor('text'), '{quote,exact}', '""'), 'Hi') $$,
  '22023', 'Invalid anchor', 'An empty quote is refused'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1,
       jsonb_set(pg_temp.anchor('text'), '{quote,prefix}', to_jsonb(repeat('x', 33))), 'Hi') $$,
  '22023', 'Invalid anchor', 'Context longer than 32 characters is refused'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1,
       jsonb_set(pg_temp.anchor('text'), '{position,end}', '9'), 'Hi') $$,
  '22023', 'Invalid anchor', 'A position that ends where it starts is refused'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1,
       jsonb_set(pg_temp.anchor('text'), '{position,start}', '1.5'), 'Hi') $$,
  '22023', 'Invalid anchor', 'A position that is not a whole number is refused'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('drawing'), 1,
       jsonb_set(pg_temp.anchor('element'), '{point,x}', '1.5'), 'Hi') $$,
  '22023', 'Invalid anchor', 'A point outside the element is refused'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('drawing'), 1,
       jsonb_set(pg_temp.anchor('element'), '{point,x}', '"0.5"'), 'Hi') $$,
  '22023', 'Invalid anchor', 'A point that is not a number is refused'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1, null, 'Hi') $$,
  '22023', 'Invalid anchor', 'A missing anchor is refused'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1, pg_temp.anchor('document'), E' \n ') $$,
  '22023', 'A comment is 1 to 5000 characters', 'A blank comment is refused'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1, pg_temp.anchor('document'), repeat('x', 5001)) $$,
  '22023', 'A comment is 1 to 5000 characters', 'A comment over 5000 characters is refused'
);
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(3), pg_temp.r(90), '') $$,
  '22023', 'A comment is 1 to 5000 characters', 'An empty reply is refused'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('other'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '22023', 'No such file in this project', 'A file from another project is refused'
);
select lives_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(7), pg_temp.file('b'), 1, pg_temp.anchor('document'), repeat('x', 5000)) $$,
  'A 5000-character comment is fine'
);
select is(
  public.add_comment(pg_temp.project('P'), pg_temp.t(7), pg_temp.file('b'), 1, pg_temp.anchor('document'), repeat('x', 5000)) #> '{thread,id}',
  to_jsonb(pg_temp.t(7)),
  'Repeating an add returns the thread it made'
);
select is(
  (select count(*)::int from public.comments where thread_id = pg_temp.t(7)),
  1,
  'and adds nothing'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(7), pg_temp.file('a'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '22023', 'This comment id was already used', 'A thread id cannot be reused on another file'
);
select pg_temp.act('bob');
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(7), pg_temp.file('b'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '22023', 'This comment id was already used', 'nor by someone else'
);
select pg_temp.act('carol');
select is(
  public.reply_comment(pg_temp.t(7), pg_temp.r(7), 'A reply') #> '{comment,id}',
  to_jsonb(pg_temp.r(7)),
  'Carol replies'
);
select is(
  public.reply_comment(pg_temp.t(7), pg_temp.r(7), 'A reply') #> '{comment,id}',
  to_jsonb(pg_temp.r(7)),
  'Repeating a reply returns the same comment'
);
select is((select count(*)::int from public.comments where thread_id = pg_temp.t(7)), 2, 'and adds no row');
select pg_temp.act('bob');
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(7), pg_temp.r(7), 'A reply') $$,
  '22023', 'This comment id was already used', 'Someone else cannot reuse a reply id'
);

-- Ids taken in a project the caller cannot read. In his own project, Frank
-- tries the thread and reply ids from P. Each goes through the checks an
-- unused id goes through, gets the answer a missing comment gets, and
-- writes nothing.
select pg_temp.act('frank');
select throws_ok(
  $$ select public.add_comment(pg_temp.project('O'), pg_temp.t(7), pg_temp.file('other'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '42501', 'Comment unavailable', 'A thread id from a project Frank cannot read gets the answer a missing comment gets'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('O'), pg_temp.t(7), pg_temp.file('a'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '22023', 'No such file in this project', 'after the checks an unused id goes through'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('O'), pg_temp.t(96), pg_temp.file('a'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '22023', 'No such file in this project', 'which answer an unused id the same way'
);
select lives_ok(
  $$ select public.add_comment(pg_temp.project('O'), pg_temp.t(95), pg_temp.file('other'), 1, pg_temp.anchor('document'), 'Mine') $$,
  'Frank starts a thread in his own project'
);
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(95), pg_temp.r(7), 'Hi') $$,
  '42501', 'Comment unavailable', 'A reply id from a project Frank cannot read gets the same answer'
);
select lives_ok($$ select public.archive_project(pg_temp.project('O')) $$, 'Frank archives his project');
select throws_ok(
  $$ select public.add_comment(pg_temp.project('O'), pg_temp.t(7), pg_temp.file('other'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '55000', 'Project is archived', 'Archived, the thread id from P'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('O'), pg_temp.t(96), pg_temp.file('other'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '55000', 'Project is archived', 'and an unused one get the same answer'
);
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(95), pg_temp.r(7), 'Hi') $$,
  '55000', 'Project is archived', 'and so do the reply id from P'
);
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(95), pg_temp.r(96), 'Hi') $$,
  '55000', 'Project is archived', 'and an unused one'
);
select lives_ok($$ select public.unarchive_project(pg_temp.project('O')) $$, 'Frank unarchives it');
select is(
  array[
    (select count(*)::int from public.comment_threads where project_id = pg_temp.project('O')),
    (select count(*)::int from public.comments where project_id = pg_temp.project('O'))
  ],
  array[1, 1],
  'Nothing but his own thread was written'
);

------------------------------------------------------------------------------
-- Archived projects: listing works, writes wait.

select pg_temp.act('bob');
select lives_ok($$ select public.archive_project(pg_temp.project('P')) $$, 'Bob archives the project');
select pg_temp.act('carol');
select is(jsonb_array_length(public.list_comments(pg_temp.project('P')) -> 'threads'), 4, 'Listing still works');
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(8), pg_temp.file('b'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '55000', 'Project is archived', 'No new threads'
);
select is(
  public.add_comment(pg_temp.project('P'), pg_temp.t(7), pg_temp.file('b'), 1, pg_temp.anchor('document'), repeat('x', 5000)) #> '{thread,id}',
  to_jsonb(pg_temp.t(7)),
  'but an add from before the archive, repeated, still returns its thread'
);
select is(
  public.reply_comment(pg_temp.t(7), pg_temp.r(7), 'A reply') #> '{comment,id}',
  to_jsonb(pg_temp.r(7)),
  'and so does a repeated reply'
);
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(7), pg_temp.r(8), 'Hi') $$,
  '55000', 'Project is archived', 'No replies'
);
select throws_ok(
  $$ select public.edit_comment(pg_temp.r(7), 'Changed') $$,
  '55000', 'Project is archived', 'No edits'
);
select throws_ok(
  $$ select public.resolve_comment(pg_temp.t(7)) $$,
  '55000', 'Project is archived', 'No resolving'
);
select throws_ok(
  $$ select public.reopen_comment(pg_temp.t(7)) $$,
  '55000', 'Project is archived', 'No reopening'
);
select throws_ok(
  $$ select public.delete_comment(pg_temp.r(7)) $$,
  '55000', 'Project is archived', 'No deleting comments'
);
select throws_ok(
  $$ select public.delete_comment_thread(pg_temp.t(7)) $$,
  '55000', 'Project is archived', 'No deleting threads'
);
select pg_temp.act('dave');
select throws_ok(
  $$ select public.resolve_comment(pg_temp.t(7)) $$,
  '42501', 'Commenting needs commenter access', 'A viewer is told about their role first'
);
select pg_temp.act('bob');
select lives_ok($$ select public.unarchive_project(pg_temp.project('P')) $$, 'Bob unarchives it');
select pg_temp.act('carol');
select lives_ok($$ select public.resolve_comment(pg_temp.t(7)) $$, 'and writes work again');

------------------------------------------------------------------------------
-- Files: threads follow a move, and outlive a delete.

select lives_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(10), pg_temp.file('a'), 1, pg_temp.anchor('text'), 'On a') $$,
  'Carol starts a thread on notes/a.md'
);
select pg_temp.act('alice');
select is(
  public.save_files(pg_temp.project('P'), gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('op', 'move', 'path', 'notes/a.md', 'to', 'notes/moved.md', 'base_version',
      (select version from public.project_files where id = pg_temp.file('a'))))) ->> 'status',
  'saved',
  'Alice moves notes/a.md'
);
select pg_temp.act('dave');
select is(
  pg_temp.listed(pg_temp.project('P'), pg_temp.t(10)) -> 'path',
  '"notes/moved.md"',
  'The thread is listed under the new path'
);
select pg_temp.act('alice');
select is(
  public.save_files(pg_temp.project('P'), gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('op', 'delete', 'path', 'notes/moved.md', 'base_version',
      (select version from public.project_files where id = pg_temp.file('a'))))) ->> 'status',
  'saved',
  'Alice deletes it'
);
select is(
  (select jsonb_build_object('path', t -> 'path', 'file_deleted', t -> 'file_deleted')
   from pg_temp.listed(pg_temp.project('P'), pg_temp.t(10)) t),
  '{"path": "notes/moved.md", "file_deleted": true}',
  'The thread stays, listed under the file''s last path as deleted'
);
select pg_temp.act('carol');
select lives_ok(
  $$ select public.reply_comment(pg_temp.t(10), pg_temp.r(10), 'Still here');
     select public.resolve_comment(pg_temp.t(10)) $$,
  'It still takes replies and resolves'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('a'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '22023', 'No such file in this project', 'but a deleted file takes no new threads'
);
select pg_temp.act('alice');
select is(
  jsonb_array_length(public.list_comments(pg_temp.project('P'),
    ((public.save_files(pg_temp.project('P'), gen_random_uuid(), '[{"op": "put", "path": "notes/a.md", "content": "New"}]')
      #>> '{changes,0,id}')::uuid)) -> 'threads'),
  0,
  'A new file at the old path has no threads'
);

------------------------------------------------------------------------------
-- Revisions and change signals, in project S.

select is(
  array[
    public.add_comment(pg_temp.project('S'), pg_temp.t(20), pg_temp.file('s'), 1, pg_temp.anchor('document'), 'One') ->> 'revision',
    public.reply_comment(pg_temp.t(20), pg_temp.r(20), 'Two') ->> 'revision',
    public.edit_comment(pg_temp.r(20), 'Two, edited') ->> 'revision',
    public.edit_comment(pg_temp.r(20), 'Two, edited') ->> 'revision',
    public.resolve_comment(pg_temp.t(20)) ->> 'revision',
    public.resolve_comment(pg_temp.t(20)) ->> 'revision',
    public.reopen_comment(pg_temp.t(20)) ->> 'revision',
    public.reopen_comment(pg_temp.t(20)) ->> 'revision',
    public.delete_comment(pg_temp.r(20)) ->> 'revision',
    public.delete_comment(pg_temp.r(20)) ->> 'revision',
    public.delete_comment_thread(pg_temp.t(20)) ->> 'revision'
  ],
  array['2', '3', '4', '4', '5', '5', '6', '6', '7', '7', '8'],
  'Each write that changes something raises the revision by one; the others leave it'
);
select is(public.list_comments(pg_temp.project('S')) -> 'revision', '8', 'A list returns the current revision');
reset role;
select is(
  array(select (payload ->> 'revision')::int from realtime.messages
        where topic = 'project:' || pg_temp.project('S') and event = 'changed' order by 1),
  array[2, 3, 4, 5, 6, 7, 8],
  'Each change queues one signal with its revision, and the others queue none'
);
select is(
  (select count(*)::int from realtime.messages
   where topic = 'project:' || pg_temp.project('S') and payload - 'id' <> jsonb_build_object('revision', payload -> 'revision')),
  0,
  'The signals carry only the revision'
);

------------------------------------------------------------------------------
-- The rate limit.

select pg_temp.set_uses(pg_temp.id('carol'), 'comment_writes_per_minute', 119);
set local role authenticated;
select pg_temp.act('carol');
select lives_ok($$ select public.reopen_comment(pg_temp.t(7)) $$, 'The 120th comment change in a minute goes through');
select throws_like(
  $$ select public.resolve_comment(pg_temp.t(7)) $$,
  'You have reached the limit of 120 comment changes a minute. Try again in % second%.',
  'The 121st is refused, saying which limit and when it resets'
);
select is(
  pg_temp.error_detail($$ select public.resolve_comment(pg_temp.t(7)) $$),
  'comment_writes_per_minute',
  'with the limit''s name as the detail'
);
select throws_ok($$ select public.delete_comment(pg_temp.r(7)) $$, 'PT429', null, 'Every kind of write counts');
select lives_ok($$ select public.list_comments(pg_temp.project('P')) $$, 'Listing does not count');
select pg_temp.act('bob');
select lives_ok($$ select public.resolve_comment(pg_temp.t(7)) $$, 'Someone else still writes');
reset role;
select pg_temp.set_uses(pg_temp.id('carol'), 'comment_writes_per_minute', 0);
set local role authenticated;

------------------------------------------------------------------------------
-- Membership changes.

select pg_temp.act('gina');
select lives_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(9), pg_temp.file('b'), 1, pg_temp.anchor('document'), 'Gina here') $$,
  'Gina comments'
);
reset role;
delete from auth.users where id = pg_temp.id('gina');
set local role authenticated;
select pg_temp.act('alice');
select is(
  (pg_temp.listed(pg_temp.project('P'), pg_temp.t(9)) #> '{comments,0}') - 'id' - 'created_at',
  '{"author": null, "via_agent": false, "body": "Gina here", "edited_at": null, "deleted_at": null}',
  'A deleted account''s comments stay, with no author'
);
select lives_ok(
  $$ select public.share_project(pg_temp.project('P'), pg_temp.id('carol'), null) $$,
  'Alice removes Carol from the project'
);
select pg_temp.act('carol');
select throws_ok(
  $$ select public.list_comments(pg_temp.project('P')) $$,
  '42501', 'Project unavailable', 'Carol can no longer list comments'
);
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(7), pg_temp.r(91), 'Hi') $$,
  '42501', 'Comment unavailable', 'or write them'
);
select pg_temp.act('alice');
select is(
  pg_temp.listed(pg_temp.project('P'), pg_temp.t(7)) #> '{comments,0,author,email}',
  '"carol@example.com"',
  'Her comments stay, with her email'
);
select lives_ok(
  $$ select public.share_project(pg_temp.project('P'), pg_temp.id('bob'), 'viewer') $$,
  'Alice makes Bob a viewer'
);
select pg_temp.act('bob');
select throws_ok(
  format('select public.edit_comment(%L, %L)', pg_temp.comment_by(pg_temp.t(2), 'bob'), 'Changed'),
  '42501', 'Commenting needs commenter access', 'Bob can no longer edit his own comments'
);
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(2), pg_temp.r(92), 'Hi') $$,
  '42501', 'Commenting needs commenter access', 'or reply'
);

------------------------------------------------------------------------------
-- Caps: 1000 threads a file, 10000 comments a project.

reset role;
insert into public.comment_threads (id, project_id, file_id, file_version, anchor, created_by)
select gen_random_uuid(), pg_temp.project('P'), pg_temp.file('busy'), 1, '{"kind": "document"}', pg_temp.id('alice')
from generate_series(1, 1000);
set local role authenticated;
select pg_temp.act('alice');
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('busy'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '54000', 'A file can have at most 1000 comment threads', 'A file takes at most 1000 threads, resolved or not'
);
reset role;
insert into public.comments (thread_id, project_id, author_id, body)
select pg_temp.t(2), pg_temp.project('P'), pg_temp.id('alice'), 'x'
from generate_series(1, 10000 - (select count(*) from public.comments where project_id = pg_temp.project('P')));
set local role authenticated;
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(2), pg_temp.r(93), 'Hi') $$,
  '54000', 'A project can hold at most 10000 comments', 'A project holds at most 10000 comments'
);
select throws_ok(
  $$ select public.add_comment(pg_temp.project('P'), pg_temp.t(90), pg_temp.file('b'), 1, pg_temp.anchor('document'), 'Hi') $$,
  '54000', 'A project can hold at most 10000 comments', 'placeholders included, for new threads too'
);

------------------------------------------------------------------------------
-- Deleting a project takes the ids of its deleted threads with it.

reset role;
select is(
  (select count(*)::int from private.deleted_comment_threads where project_id = pg_temp.project('S')),
  1,
  'Project S remembers its one deleted thread'
);
set local role authenticated;
select pg_temp.act('alice');
select lives_ok($$ select public.delete_project(pg_temp.project('S')) $$, 'Alice deletes project S');
reset role;
select is(
  (select count(*)::int from private.deleted_comment_threads where project_id = pg_temp.project('S')),
  0,
  'and its deleted thread ids go with it'
);

select * from finish();
rollback;
