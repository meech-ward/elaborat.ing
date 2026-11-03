-- Link possession grants one rendered file, never project membership or the
-- project's private discussion. Fixtures and all mutations roll back.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select table_privs_are('private', 'file_shares', 'anon', array[]::text[], 'Anonymous users cannot select capability rows');
select table_privs_are('private', 'file_shares', 'authenticated', array[]::text[], 'Accounts cannot select raw capability rows');
select table_privs_are('private', 'file_share_threads', 'anon', array[]::text[], 'Anonymous users cannot select thread rows');
select table_privs_are('private', 'file_share_threads', 'authenticated', array[]::text[], 'Accounts cannot select raw thread rows');
select table_privs_are('private', 'file_share_comments', 'anon', array[]::text[], 'Anonymous users cannot select comment rows');
select table_privs_are('private', 'file_share_comments', 'authenticated', array[]::text[], 'Accounts cannot select raw comment rows');
select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'private.file_shares'::regclass, 'private.file_share_threads'::regclass, 'private.file_share_comments'::regclass
)), 'Every link table has row-level security');
select is((select count(*)::int from pg_policies where schemaname = 'private' and tablename in ('file_shares', 'file_share_threads', 'file_share_comments')), 3, 'Every link table declares its deny-direct-access policy');
select ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like '%file_share%' and p.prosecdef
), 'Exposed link functions never run as definer');
select function_privs_are('public', 'file_share_context', array['text'], 'anon', array[]::text[], 'Anonymous users cannot get server context');
select function_privs_are('public', 'file_share_context', array['text'], 'authenticated', array[]::text[], 'Accounts cannot get server context');
select function_privs_are('public', 'file_share_context', array['text'], 'service_role', array['EXECUTE'], 'The service may resolve a file capability');
select function_privs_are('public', 'file_share_dependencies', array['text', 'text[]'], 'anon', array[]::text[], 'Anonymous users cannot request arbitrary dependency paths');
select function_privs_are('public', 'file_share_dependencies', array['text', 'text[]'], 'authenticated', array[]::text[], 'Account sessions cannot request arbitrary dependency paths');
select function_privs_are('public', 'file_share_dependencies', array['text', 'text[]'], 'service_role', array['EXECUTE'], 'Only the service can fetch parsed dependency paths');
select ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname like '%file_share%'
    and p.proname <> 'list_file_share_comments' and has_function_privilege('anon', p.oid, 'EXECUTE')
), 'Anonymous users can execute only the public discussion projection');
select function_privs_are('private', 'active_file_share', array['text'], 'authenticated', array[]::text[], 'Accounts cannot call internal token resolver');
select function_privs_are('private', 'lock_file_share_comment', array['text'], 'authenticated', array[]::text[], 'Accounts cannot call internal write-lock helper');

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'share-owner@example.com', '{"display_name":"Owner"}'),
  ('22222222-2222-4222-8222-222222222222', 'share-visitor@example.com', '{"display_name":"Visitor"}'),
  ('33333333-3333-4333-8333-333333333333', 'share-other@example.com', '{"display_name":"hidden@example.com"}'),
  ('44444444-4444-4444-8444-444444444444', 'share-editor@example.com', '{}');
insert into public.projects (id, owner_id, title, revision) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Private project title', 7),
  ('bbbbbbbb-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'Other project', 11);
insert into public.project_files(id, project_id, path, content, version) values
  ('f0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'share.mdx', '# Share me', 7),
  ('f0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'secret.md', '# Private', 7),
  ('f0000000-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000001', 'other.md', '# Other', 11);
insert into public.project_members(project_id,user_id,role,accepted_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001','44444444-4444-4444-8444-444444444444','editor',now());
insert into public.image_assets(id,project_id,object_key,preview_key,sha256,media_type,byte_length,width,height,state,committed_at,preview_type,preview_byte_length)
values('e0000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000001/original',
  'aaaaaaaa-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000001/preview',
  repeat('a',64),'image/png',100,1,1,'committed',now(),'image/png',70);
insert into public.project_files(id,project_id,path,content,version,kind,asset_id,asset) values
  ('f0000000-0000-4000-8000-000000000005','aaaaaaaa-0000-4000-8000-000000000001','photo.png','',7,'image','e0000000-0000-4000-8000-000000000001','{"object_key":"untrusted snapshot"}');
insert into public.comment_threads(id, project_id, file_id, file_version, anchor, created_by) values
  ('c0000000-0000-4000-8000-000000000099','aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',7,'{"kind":"document"}','11111111-1111-4111-8111-111111111111');
insert into public.comments(thread_id,project_id,author_id,body) values
  ('c0000000-0000-4000-8000-000000000099','aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','Internal discussion never published');

create temp table share_state(key text primary key, value jsonb);
grant all on table share_state to anon, authenticated, service_role;
create function pg_temp.token() returns text language sql as $$ select value ->> 'token' from pg_temp.share_state where key='share' $$;
create function pg_temp.old_token() returns text language sql as $$ select value ->> 'token' from pg_temp.share_state where key='old' $$;
create function pg_temp.act(user_id uuid, agent boolean default false) returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('sub',user_id,'role','authenticated')
    || case when agent then '{"client_id":"agent-client"}'::jsonb else '{}'::jsonb end)::text, true)
$$;

set local role authenticated;
select pg_temp.act('11111111-1111-4111-8111-111111111111');
select is(public.get_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001'), null::jsonb, 'File sharing starts disabled');
select is(public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',false), null::jsonb, 'Disabling an absent link does not create one');
insert into pg_temp.share_state values('share',public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',true));
select ok(pg_temp.token() ~ '^[0-9a-f]{64}$', 'A link has a cryptographically random 256-bit token');
select is(public.get_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001')->>'token', pg_temp.token(), 'An owner can copy their existing link again');
select is(public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',true)->>'token',pg_temp.token(),'Enabling an already enabled link is idempotent');
select throws_ok($$select public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',null)$$,'22023',null,'Link state must be explicit');
select throws_ok($$select public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000003',true)$$,'42501','File unavailable','A foreign file cannot be bound to an owned project');
select throws_ok($$select * from private.file_shares$$,'42501',null,'Even an owner cannot directly enumerate capability rows');
select throws_ok($$select public.file_share_context(pg_temp.token())$$,'42501',null,'An owner cannot bypass the dependency API');
select pg_temp.act('11111111-1111-4111-8111-111111111111',true);
select throws_ok($$select public.get_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001')$$,'42501',null,'Agents cannot read the owner share capability');
select throws_ok($$select public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',false)$$,'42501',null,'Agents cannot revoke a link');
select pg_temp.act('44444444-4444-4444-8444-444444444444');
select throws_ok($$select public.get_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001')$$,'42501','File unavailable','Project editors cannot inspect owner link secrets');
select throws_ok($$select public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',true)$$,'42501','File unavailable','Project editors cannot publish files');

set local role anon;
set local request.jwt.claims to '{}';
select is(public.list_file_share_comments(pg_temp.token())->'threads','[]'::jsonb,'Visitors start with a separate empty public discussion');
select is(public.list_file_share_comments(pg_temp.token())->'can_moderate','false'::jsonb,'Anonymous visitors cannot moderate');
select throws_ok($$select public.list_file_share_comments(repeat('0',64))$$,'42501','Shared file unavailable','An unknown token has no access');
select throws_ok($$select public.list_file_share_comments('invalid')$$,'42501','Shared file unavailable','Malformed tokens use the same refusal');
select throws_ok($$select public.list_file_share_comments(null)$$,'42501','Shared file unavailable','Null tokens use the same refusal');
select throws_ok($$select * from public.project_files$$,'42501',null,'Anonymous links never open the project file table');
select throws_ok($$select * from private.file_share_comments$$,'42501',null,'Anonymous comments are only available through the safe projection');
select throws_ok($$select public.get_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001')$$,'42501',null,'Anonymous visitors cannot enumerate owner links');
select throws_ok($$select public.add_file_share_comment(pg_temp.token(),gen_random_uuid(),gen_random_uuid(),7,'{"kind":"document"}','Anonymous')$$,'42501',null,'Visitors must sign in before posting');

set local role service_role;
select throws_ok($$select * from public.project_files$$,'42501',null,'Service reads do not require or add broad file table grants');
select throws_ok($$select * from public.image_assets$$,'42501',null,'The service cannot enumerate image reservations directly');
select is(public.file_share_context(pg_temp.token())->>'file_id','f0000000-0000-4000-8000-000000000001','Server context is bound to the root file id');
select is(public.file_share_context(pg_temp.token())->>'content','# Share me','Server context contains only the current root');
select is(public.file_share_context(pg_temp.token())->>'revision','7','Server context revision is the project revision for consistent dependency reads');
select ok(not (public.file_share_context(pg_temp.token()) ? 'title'),'Server context does not unnecessarily include the private project title');
select is(public.file_share_dependencies(pg_temp.token(),array['secret.md'])#>>'{0,path}','secret.md','The trusted server can resolve its parsed dependency path');
select is(public.file_share_dependencies(pg_temp.token(),array['other.md']),'[]'::jsonb,'Dependency reads stay in the token project even for valid foreign paths');
select is(public.file_share_dependencies(pg_temp.token(),array['missing.md']),'[]'::jsonb,'Missing dependency paths give an empty list');
select throws_ok($$select public.file_share_dependencies(pg_temp.token(),array['../secret.md'])$$,'22023',null,'Dependency paths cannot escape the project');
select throws_ok($$select public.file_share_dependencies(pg_temp.token(),array_fill('secret.md'::text,array[129]))$$,'22023',null,'Dependency batches are bounded');
select throws_ok($$select public.file_share_dependencies(repeat('0',64),array['secret.md'])$$,'42501','Shared file unavailable','Server dependency reads still require a valid active capability');
select is(public.file_share_dependencies(pg_temp.token(),array['photo.png'])#>>'{0,asset,object_key}',
  'aaaaaaaa-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000001/original','Image metadata is projected from a committed asset instead of trusting a snapshot');
select ok(not ((public.file_share_dependencies(pg_temp.token(),array['photo.png'])#>'{0,asset}') ? 'created_by'),'Image projection excludes uploader metadata');
select ok(not ((public.file_share_dependencies(pg_temp.token(),array['photo.png'])#>'{0,asset}') ? 'expires_at'),'Image projection excludes reservation metadata');

set local role authenticated;
select pg_temp.act('22222222-2222-4222-8222-222222222222');
select is((select count(*)::int from public.projects),0,'A link recipient has no project access');
select is((select count(*)::int from public.project_files),0,'A link recipient cannot enumerate related files');
select is((select count(*)::int from public.comment_threads),0,'A link recipient cannot see internal discussion');
select lives_ok($$select public.add_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001',7,'{"kind":"document"}','Public feedback')$$,'A signed-in visitor can comment without membership');
select is(jsonb_array_length(public.list_file_share_comments(pg_temp.token())->'threads'),1,'Only public link threads are listed');
select is(public.list_file_share_comments(pg_temp.token())#>>'{threads,0,comments,0,author,name}','Visitor','Public discussion shows a safe display name');
select is(public.list_file_share_comments(pg_temp.token())#>'{threads,0,comments,0,author,email}','null'::jsonb,'Public discussion never returns email');
select is(public.list_file_share_comments(pg_temp.token())#>>'{threads,0,comments,0,via_agent}','false','Public comments identify real people');
select lives_ok($$select public.add_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001',7,'{"kind":"document"}','Retry')$$,'Retrying a post with stable ids returns the original thread');
select is(public.list_file_share_comments(pg_temp.token())#>>'{threads,0,comments,0,body}','Public feedback','A retry never overwrites the initial words');
select throws_ok($$select public.add_file_share_comment(pg_temp.token(),gen_random_uuid(),gen_random_uuid(),6,'{"kind":"document"}','Stale')$$,'40001',null,'A stale file version cannot start a new comment');
select throws_ok($$select public.add_file_share_comment(pg_temp.token(),null,gen_random_uuid(),7,'{"kind":"document"}','No id')$$,'22023',null,'A thread id is required');
select throws_ok($$select public.add_file_share_comment(pg_temp.token(),gen_random_uuid(),gen_random_uuid(),7,'{"kind":"text"}','Malformed')$$,'22023',null,'Anchors use the existing strict shape checks');
select throws_ok($$select public.add_file_share_comment(pg_temp.token(),gen_random_uuid(),gen_random_uuid(),7,'{"kind":"document"}',repeat('x',10001))$$,'22023',null,'Public comments have a bounded body');
select throws_ok($$select public.add_file_share_comment(pg_temp.token(),gen_random_uuid(),gen_random_uuid(),7,'{"kind":"document"}','   ')$$,'22023',null,'Blank comments are refused');
select lives_ok($$select public.reply_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002','A reply')$$,'Visitors can reply to a public thread');
select lives_ok($$select public.reply_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002','Retry reply')$$,'Reply ids make retries idempotent');
select is(jsonb_array_length(public.list_file_share_comments(pg_temp.token())#>'{threads,0,comments}'),2,'Retrying adds no duplicate reply');
select lives_ok($$select public.edit_file_share_comment(pg_temp.token(),'d0000000-0000-4000-8000-000000000002','Edited reply')$$,'Visitors can edit their own reply');
select is(public.list_file_share_comments(pg_temp.token())#>>'{threads,0,comments,1,body}','Edited reply','The edited words are returned');
select lives_ok($$select public.resolve_file_share_thread(pg_temp.token(),'c0000000-0000-4000-8000-000000000001',true)$$,'Thread creators can resolve their discussion');
select lives_ok($$select public.resolve_file_share_thread(pg_temp.token(),'c0000000-0000-4000-8000-000000000001',false)$$,'Thread creators can reopen their discussion');

select pg_temp.act('33333333-3333-4333-8333-333333333333');
select throws_ok($$select public.edit_file_share_comment(pg_temp.token(),'d0000000-0000-4000-8000-000000000001','Overwrite')$$,'42501','Comment unavailable','Other visitors cannot edit someone else words');
select throws_ok($$select public.delete_file_share_comment(pg_temp.token(),'d0000000-0000-4000-8000-000000000001')$$,'42501','Comment unavailable','Other visitors cannot delete someone else comment');
select throws_ok($$select public.resolve_file_share_thread(pg_temp.token(),'c0000000-0000-4000-8000-000000000001',true)$$,'42501','Comment unavailable','Other visitors cannot resolve someone else thread');
select throws_ok($$select public.reply_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000099',gen_random_uuid(),'Internal thread')$$,'42501','Comment unavailable','Private thread ids cannot receive public replies');
select throws_ok($$select public.reply_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002','Take id')$$,'42501','Comment unavailable','A foreign comment id cannot be reused');
select lives_ok($$select public.reply_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000003','Other feedback')$$,'Other signed-in visitors can participate');
select is(public.list_file_share_comments(pg_temp.token())#>>'{threads,0,comments,2,author,name}','Guest','Email-shaped names are not published');
select ok(public.list_file_share_comments(pg_temp.token())::text not like '%@%','No response contains account email addresses');

select pg_temp.act('11111111-1111-4111-8111-111111111111');
select is(public.list_file_share_comments(pg_temp.token())->>'can_moderate','true','The current project owner can moderate');
select throws_ok($$select public.edit_file_share_comment(pg_temp.token(),'d0000000-0000-4000-8000-000000000001','Owner rewrite')$$,'42501','Comment unavailable','An owner cannot rewrite another person words');
select lives_ok($$select public.resolve_file_share_thread(pg_temp.token(),'c0000000-0000-4000-8000-000000000001',true)$$,'The owner can resolve public discussion');
select lives_ok($$select public.delete_file_share_comment(pg_temp.token(),'d0000000-0000-4000-8000-000000000003')$$,'The owner can moderate a public comment');
select is(public.list_file_share_comments(pg_temp.token())#>'{threads,0,comments,2,body}','null'::jsonb,'Moderation removes the public body');
select lives_ok($$select public.delete_file_share_comment(pg_temp.token(),'d0000000-0000-4000-8000-000000000003')$$,'Repeating soft deletion is idempotent');

select pg_temp.act('22222222-2222-4222-8222-222222222222',true);
select throws_ok($$select public.add_file_share_comment(pg_temp.token(),gen_random_uuid(),gen_random_uuid(),7,'{"kind":"document"}','Agent')$$,'42501',null,'OAuth agents cannot post to public discussions');
select throws_ok($$select public.edit_file_share_comment(pg_temp.token(),'d0000000-0000-4000-8000-000000000002','Agent edit')$$,'42501',null,'Agents still cannot edit people words');
select throws_ok($$select public.delete_file_share_comment(pg_temp.token(),'d0000000-0000-4000-8000-000000000002')$$,'42501',null,'Agents still cannot delete comments');
select pg_temp.act('22222222-2222-4222-8222-222222222222');
select lives_ok($$select public.delete_file_share_comment(pg_temp.token(),'d0000000-0000-4000-8000-000000000002')$$,'A person can remove their own reply');
select throws_ok($$select public.reply_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002','Restore deleted')$$,'42501',null,'A retried deleted reply cannot resurrect its words');

reset role;
select is((select revision from public.projects where id='aaaaaaaa-0000-4000-8000-000000000001'),7::bigint,'Public link comments never change project content revision');
select is((select count(*)::int from public.project_members where project_id='aaaaaaaa-0000-4000-8000-000000000001'),1,'Public comment authors are never added as project members');
select is((select count(*)::int from private.file_share_comments where deleted_at is not null),2,'Deleted comments are retained as soft-deleted rows');
update public.projects set archived_at=now() where id='aaaaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.act('22222222-2222-4222-8222-222222222222');
select is(public.list_file_share_comments(pg_temp.token())->>'archived','true','Archived projects retain readable public discussion');
select throws_ok($$select public.add_file_share_comment(pg_temp.token(),gen_random_uuid(),gen_random_uuid(),7,'{"kind":"document"}','Archived')$$,'55000','Project is archived','Archived projects reject public comment posts');
select throws_ok($$select public.edit_file_share_comment(pg_temp.token(),'d0000000-0000-4000-8000-000000000001','Archived edit')$$,'55000','Project is archived','Archived projects reject public comment edits');
select throws_ok($$select public.resolve_file_share_thread(pg_temp.token(),'c0000000-0000-4000-8000-000000000001',false)$$,'55000','Project is archived','Archived projects reject public comment resolves');
select pg_temp.act('11111111-1111-4111-8111-111111111111');
insert into pg_temp.share_state select 'old',value from pg_temp.share_state where key='share';
update pg_temp.share_state set value=public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',true,true) where key='share';
select isnt(pg_temp.token(),pg_temp.old_token(),'Replacing the link creates a new unpredictable capability even while archived');
select throws_ok($$select public.list_file_share_comments(pg_temp.old_token())$$,'42501','Shared file unavailable','Replacing invalidates the old URL');
select is(jsonb_array_length(public.list_file_share_comments(pg_temp.token())->'threads'),1,'Replacing a link preserves public discussion');
select lives_ok($$select public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',false)$$,'Owners can revoke links to archived files');
select throws_ok($$select public.list_file_share_comments(pg_temp.token())$$,'42501','Shared file unavailable','Revocation blocks public discussion immediately');
update pg_temp.share_state set value=public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',true) where key='share';
select isnt(pg_temp.token(),pg_temp.old_token(),'Re-enabling never reuses a previous capability');

reset role;
update public.projects set archived_at=null where id='aaaaaaaa-0000-4000-8000-000000000001';
update public.project_files set path='renamed.mdx',content='# Updated',version=8 where id='f0000000-0000-4000-8000-000000000001';
update public.projects set revision=8 where id='aaaaaaaa-0000-4000-8000-000000000001';
set local role service_role;
select is(public.file_share_context(pg_temp.token())->>'path','renamed.mdx','A stable file id follows rename');
select is(public.file_share_context(pg_temp.token())->>'content','# Updated','Links always read the latest saved root content');
select is(public.file_share_context(pg_temp.token())->>'version','8','Links expose the current file version');
set local role authenticated;
select pg_temp.act('11111111-1111-4111-8111-111111111111');
select is(public.list_file_share_comments(pg_temp.token())#>>'{threads,0,path}','renamed.mdx','Public discussion follows its stable file id');

-- Different links cannot address the same thread, even if the caller owns
-- another project or guesses its thread id.
select pg_temp.act('33333333-3333-4333-8333-333333333333');
insert into pg_temp.share_state values('other',public.set_file_share('bbbbbbbb-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000003',true));
select throws_ok($$select public.reply_file_share_comment((select value->>'token' from pg_temp.share_state where key='other'),'c0000000-0000-4000-8000-000000000001',gen_random_uuid(),'Wrong link')$$,'42501','Comment unavailable','Another valid link grants no access to this discussion');
select is(jsonb_array_length(public.list_file_share_comments((select value->>'token' from pg_temp.share_state where key='other'))->'threads'),0,'A separate shared file has a separate discussion');

reset role;
update public.projects set owner_id='22222222-2222-4222-8222-222222222222' where id='aaaaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.act('11111111-1111-4111-8111-111111111111');
select throws_ok($$select public.get_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001')$$,'42501','File unavailable','Previous owners cannot manage capability after ownership transfer');
select pg_temp.act('22222222-2222-4222-8222-222222222222');
select is(public.get_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001')->>'token',pg_temp.token(),'The new project owner controls the existing link');
reset role;
delete from public.project_files where id='f0000000-0000-4000-8000-000000000001';
set local role anon;
set local request.jwt.claims to '{}';
select throws_ok($$select public.list_file_share_comments(pg_temp.token())$$,'42501','Shared file unavailable','Deleting the root file disables its URL');
set local role service_role;
select throws_ok($$select public.file_share_context(pg_temp.token())$$,'42501','Shared file unavailable','Deleted roots cannot be loaded through the Edge context');
reset role;
insert into public.project_files(id,project_id,path,content,version) values
  ('f0000000-0000-4000-8000-000000000004','aaaaaaaa-0000-4000-8000-000000000001','renamed.mdx','# A different file',9);
set local role anon;
select throws_ok($$select public.list_file_share_comments(pg_temp.token())$$,'42501','Shared file unavailable','A new file at the old path never inherits link access');
reset role;

select * from finish();
rollback;
