-- Public-link limits are enforced at the database boundary, independently of
-- browser validation and project membership. No fixture survives rollback.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
 ('11111111-1111-4111-8111-111111111111','link-limit-owner@example.com','{"display_name":"  ","full_name":"provider@example.com"}'),
 ('22222222-2222-4222-8222-222222222222','link-limit-visitor@example.com','{}');
insert into public.projects(id,owner_id,title,revision) values
 ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','Link limits',1);
insert into public.project_files(id,project_id,path,content,version) values
 ('f0000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','note.md','# Note',1);
create temp table link_state as select null::text as token, null::uuid as id;
grant all on link_state to authenticated, anon;
create function pg_temp.token() returns text language sql as $$ select token from pg_temp.link_state $$;
create function pg_temp.id() returns uuid language sql as $$ select id from pg_temp.link_state $$;

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
update pg_temp.link_state set token=s->>'token', id=(s->>'id')::uuid
from (select public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',true) s) result;
select lives_ok($$select public.add_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001',1,'{"kind":"document"}','Opening')$$,'A person can post through their own link');
select is(public.list_file_share_comments(pg_temp.token())#>>'{threads,0,comments,0,author,name}','Guest','Blank preferred names cannot expose a provider email fallback');
reset role;

-- Capacity counts retained deleted rows, preventing delete/retry abuse from
-- growing the private discussion tables without bound.
insert into private.file_share_threads(id,share_id,file_version,anchor,created_by)
select gen_random_uuid(),pg_temp.id(),1,'{"kind":"document"}','11111111-1111-4111-8111-111111111111' from generate_series(1,999);
set local role authenticated;
select throws_ok($$select public.add_file_share_comment(pg_temp.token(),gen_random_uuid(),gen_random_uuid(),1,'{"kind":"document"}','At capacity')$$,'54000','A shared file can have at most 1000 comment threads','Thread capacity is enforced');
reset role;

-- Existing bodies can still be edited without double-counting them. New
-- bodies cannot pass the shared 2 MiB ceiling, even below the row cap.
insert into private.file_share_comments(id,thread_id,author_id,body)
select gen_random_uuid(),'c0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',repeat('x',10000) from generate_series(1,209);
set local role authenticated;
select throws_ok($$select public.reply_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001',gen_random_uuid(),repeat('y',10000))$$,'54000','This discussion has reached its comment size limit','The discussion byte limit is enforced');
select lives_ok($$select public.edit_file_share_comment(pg_temp.token(),'d0000000-0000-4000-8000-000000000001','Revised')$$,'Editing deducts the previous body before checking the shared byte limit');
reset role;
insert into private.file_share_comments(id,thread_id,author_id,body,deleted_at)
select gen_random_uuid(),'c0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',null,now() from generate_series(1,1790);
set local role authenticated;
select throws_ok($$select public.reply_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001',gen_random_uuid(),'At capacity')$$,'54000','A shared file can have at most 2000 comments','Deleted comment tombstones count toward the row limit');

-- Link updates have a separate, serialized per-person counter and leave
-- project content and membership untouched.
select lives_ok($$select public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',true) from generate_series(1,59)$$,'The link change limit permits 60 changes in its minute');
select throws_ok($$select public.set_file_share('aaaaaaaa-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001',true)$$,'PT429',null,'The 61st link operation is refused at the database boundary');
reset role;
select is((select revision from public.projects where id='aaaaaaaa-0000-4000-8000-000000000001'),1::bigint,'Link capacity checks do not change content revisions');
select is((select count(*)::int from public.project_members),0,'No project membership was granted');

-- An anonymous-sign-in JWT and a deleted-account JWT are insufficient,
-- even if they contain a user id.
set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","is_anonymous":true}';
select throws_ok($$select public.reply_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001',gen_random_uuid(),'Anonymous account')$$,'42501',null,'Anonymous sign-ins cannot post public comments');
set local request.jwt.claims to '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}';
select throws_ok($$select public.reply_file_share_comment(pg_temp.token(),'c0000000-0000-4000-8000-000000000001',gen_random_uuid(),'Deleted account')$$,'42501',null,'A removed account cannot use a still-valid token to post');
reset role;
select * from finish();
rollback;
