-- Attaching a thread to other text (move_comment_anchor): who may move a
-- thread's anchor, that the anchor is checked as add_comment checks it, and
-- that a move raises the project revision. Run with the Supabase CLI:
-- `supabase test db` (pgTAP). Everything happens in one transaction that is
-- rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(18);

-- People, by name. Alice owns the project; Bob is an editor, Carol and Gina
-- commenters and Dave a viewer, all accepted. Carol starts the thread. Frank
-- has nothing to do with the project.
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

create function pg_temp.project()
returns uuid
language sql
immutable
as $$ select 'aaaaaaaa-0000-4000-8000-000000000001'::uuid $$;

create function pg_temp.file()
returns uuid
language sql
immutable
as $$ select 'f0000000-0000-4000-8000-00000000000a'::uuid $$;

create function pg_temp.thread()
returns uuid
language sql
immutable
as $$ select 'c0000000-0000-4000-8000-000000000001'::uuid $$;

-- A text anchor on `exact`, at `start` in the note.
create function pg_temp.text_anchor(exact text, start integer)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'kind', 'text',
    'quote', jsonb_build_object('type', 'TextQuoteSelector', 'exact', exact, 'prefix', '', 'suffix', ''),
    'position', jsonb_build_object('type', 'TextPositionSelector', 'start', start, 'end', start + char_length(exact))
  )
$$;

-- What a statement raises, as its code and message, or null when it succeeds.
create function pg_temp.refusal(statement text)
returns text
language plpgsql
as $$
begin
  execute statement;
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;

-- How much a statement raises the project's revision.
create function pg_temp.revision_change(statement text)
returns bigint
language plpgsql
as $$
declare
  before bigint;
begin
  select revision into before from public.projects where id = pg_temp.project();
  execute statement;
  return (select revision from public.projects where id = pg_temp.project()) - before;
end;
$$;

------------------------------------------------------------------------------
-- Grants.

select function_privs_are('public', 'move_comment_anchor', array['uuid', 'bigint', 'jsonb'], 'authenticated', array['EXECUTE'], 'Signed-in users can move a thread''s anchor');
select function_privs_are('public', 'move_comment_anchor', array['uuid', 'bigint', 'jsonb'], 'anon', array[]::text[], 'Anonymous users cannot');
select ok(
  has_function_privilege('authenticated', 'private.move_comment_anchor(uuid, bigint, jsonb)', 'execute')
    and not has_function_privilege('anon', 'private.move_comment_anchor(uuid, bigint, jsonb)', 'execute'),
  'Signed-in users, and not anonymous ones, can call the private function, which checks the caller itself'
);

------------------------------------------------------------------------------
-- The people, the project, its note and Carol's thread on text that is gone.

insert into auth.users (id, email)
select pg_temp.id(name), name || '@example.com'
from unnest(array['alice', 'bob', 'carol', 'dave', 'frank', 'gina']) name;

insert into public.projects (id, owner_id, title, revision) values (pg_temp.project(), pg_temp.id('alice'), 'Shared', 1);

insert into public.project_members (project_id, user_id, role, accepted_at) values
  (pg_temp.project(), pg_temp.id('bob'), 'editor', now()),
  (pg_temp.project(), pg_temp.id('carol'), 'commenter', now()),
  (pg_temp.project(), pg_temp.id('dave'), 'viewer', now()),
  (pg_temp.project(), pg_temp.id('gina'), 'commenter', now());

insert into public.project_files (id, project_id, path, content, version, updated_by) values
  (pg_temp.file(), pg_temp.project(), 'notes/a.md', E'# Guide\n\nNew words here.\n', 2, pg_temp.id('alice'));

set local role authenticated;
select pg_temp.act('carol');
select lives_ok(
  format('select public.add_comment(%L, %L, %L, 1, %L, %L)',
    pg_temp.project(), pg_temp.thread(), pg_temp.file(), pg_temp.text_anchor('Old words', 9), 'Which words?'),
  'Carol starts a thread on words a later save removed'
);

------------------------------------------------------------------------------
-- Who may move it.

select pg_temp.act('carol');
select is(
  public.move_comment_anchor(pg_temp.thread(), 2, pg_temp.text_anchor('New words', 9)) -> 'thread' -> 'anchor',
  pg_temp.text_anchor('New words', 9),
  'The thread''s creator, a commenter, attaches it to other text'
);
select is(
  (select t.file_version from public.comment_threads t where t.id = pg_temp.thread()),
  2::bigint,
  'against the version of the file the text was selected in'
);
select is(
  pg_temp.revision_change(format('select public.move_comment_anchor(%L, 2, %L)', pg_temp.thread(), pg_temp.text_anchor('words', 13))),
  1::bigint,
  'A move raises the project revision once, so open projects reload their comments'
);

select pg_temp.act('bob');
select is(
  public.move_comment_anchor(pg_temp.thread(), 2, '{"kind": "document"}') #> '{thread,anchor}',
  '{"kind": "document"}',
  'An editor who did not start it attaches it to the whole file'
);

select pg_temp.act('alice');
select is(
  public.move_comment_anchor(pg_temp.thread(), 2, pg_temp.text_anchor('Guide', 2)) #> '{thread,anchor,quote,exact}',
  '"Guide"',
  'The owner, who did not start it, moves it too'
);

select pg_temp.act('gina');
select throws_ok(
  format('select public.move_comment_anchor(%L, 2, %L)', pg_temp.thread(), pg_temp.text_anchor('New words', 9)),
  '42501', 'Only the person who started a thread, an editor or the owner can move it',
  'A commenter who did not start it cannot'
);

select pg_temp.act('dave');
select throws_ok(
  format('select public.move_comment_anchor(%L, 2, %L)', pg_temp.thread(), pg_temp.text_anchor('New words', 9)),
  '42501', 'Commenting needs commenter access',
  'A viewer cannot'
);

select pg_temp.act('frank');
select throws_ok(
  format('select public.move_comment_anchor(%L, 2, %L)', pg_temp.thread(), pg_temp.text_anchor('New words', 9)),
  '42501', 'Comment unavailable',
  'Someone without access to the project cannot, and hears only that the comment is unavailable'
);
select throws_ok(
  format('select public.move_comment_anchor(%L, 2, %L)', gen_random_uuid(), pg_temp.text_anchor('New words', 9)),
  '42501', 'Comment unavailable',
  'which is what a thread that does not exist answers'
);

select pg_temp.act('carol', true);
select throws_ok(
  format('select public.move_comment_anchor(%L, 2, %L)', pg_temp.thread(), pg_temp.text_anchor('New words', 9)),
  '42501', 'Only a signed-in person can move a comment; agents can reply',
  'Not even its creator''s agent can'
);

select pg_temp.act('carol');
select is(
  (select t.anchor #>> '{quote,exact}' from public.comment_threads t where t.id = pg_temp.thread()),
  'Guide',
  'and none of the refusals moved it'
);

------------------------------------------------------------------------------
-- The anchor is checked as add_comment checks it.

select throws_ok(
  format('select public.move_comment_anchor(%L, 2, %L)', pg_temp.thread(), '{"kind": "page"}'),
  '22023', 'Invalid anchor',
  'An anchor of no known kind is refused'
);
select throws_ok(
  format('select public.move_comment_anchor(%L, 0, %L)', pg_temp.thread(), '{"kind": "document"}'),
  '22023', 'A thread id and a positive file version are required',
  'and so is a version that is not positive'
);
select is(
  array(
    select coalesce(pg_temp.refusal(format('select public.move_comment_anchor(%L, 2, %L)', pg_temp.thread(), anchor)), 'accepted')
    from unnest(array[
      pg_temp.text_anchor('New words', 9),
      '{"kind": "section", "quote": {"type": "TextQuoteSelector", "exact": "# Guide", "prefix": "", "suffix": ""}, "position": {"type": "TextPositionSelector", "start": 0, "end": 7}}',
      '{"kind": "element", "element_id": "box-1", "label": "rectangle", "point": {"x": 0.25, "y": 1}}',
      '{"kind": "document"}',
      '{"kind": "document", "extra": true}',
      jsonb_set(pg_temp.text_anchor('New words', 9), '{quote,exact}', '""'),
      jsonb_set(pg_temp.text_anchor('New words', 9), '{quote,prefix}', to_jsonb(repeat('x', 33))),
      jsonb_set(pg_temp.text_anchor('New words', 9), '{position,end}', '9'),
      jsonb_set(pg_temp.text_anchor('New words', 9), '{position,start}', '1.5'),
      jsonb_set(pg_temp.text_anchor('New words', 9), '{position,end}', '2097153'),
      '[]',
      null
    ]::jsonb[]) with ordinality as cases (anchor, n)
    order by n
  ),
  array(
    select coalesce(pg_temp.refusal(format('select public.add_comment(%L, %L, %L, 2, %L, %L)',
      pg_temp.project(), gen_random_uuid(), pg_temp.file(), anchor, 'Hi')), 'accepted')
    from unnest(array[
      pg_temp.text_anchor('New words', 9),
      '{"kind": "section", "quote": {"type": "TextQuoteSelector", "exact": "# Guide", "prefix": "", "suffix": ""}, "position": {"type": "TextPositionSelector", "start": 0, "end": 7}}',
      '{"kind": "element", "element_id": "box-1", "label": "rectangle", "point": {"x": 0.25, "y": 1}}',
      '{"kind": "document"}',
      '{"kind": "document", "extra": true}',
      jsonb_set(pg_temp.text_anchor('New words', 9), '{quote,exact}', '""'),
      jsonb_set(pg_temp.text_anchor('New words', 9), '{quote,prefix}', to_jsonb(repeat('x', 33))),
      jsonb_set(pg_temp.text_anchor('New words', 9), '{position,end}', '9'),
      jsonb_set(pg_temp.text_anchor('New words', 9), '{position,start}', '1.5'),
      jsonb_set(pg_temp.text_anchor('New words', 9), '{position,end}', '2097153'),
      '[]',
      null
    ]::jsonb[]) with ordinality as cases (anchor, n)
    order by n
  ),
  'Every anchor add_comment takes is taken, and every one it refuses is refused with the same error'
);

select * from finish();
rollback;
