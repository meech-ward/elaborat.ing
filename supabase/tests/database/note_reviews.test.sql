begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.person(who text) returns uuid language sql immutable as $$
  select (case who when 'owner' then '11111111-1111-4111-8111-111111111111' when 'editor' then '22222222-2222-4222-8222-222222222222'
    when 'commenter' then '33333333-3333-4333-8333-333333333333' when 'viewer' then '44444444-4444-4444-8444-444444444444'
    when 'invited' then '55555555-5555-4555-8555-555555555555' else '66666666-6666-4666-8666-666666666666' end)::uuid
$$;
create function pg_temp.act(who text, agent boolean default false) returns void language sql as $$
  select set_config('request.jwt.claims',(jsonb_build_object('sub',pg_temp.person(who),'role','authenticated') ||
    case when agent then jsonb_build_object('client_id','a9000000-0000-4000-8000-000000000001') else '{}'::jsonb end)::text,true)
$$;
create function pg_temp.project() returns uuid language sql immutable as $$ select 'a9000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.review() returns uuid language sql immutable as $$ select 'a9000000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.file_id() returns uuid language sql as $$ select file_id from public.file_versions where project_id=pg_temp.project() and path='note.mdx' order by version limit 1 $$;
create function pg_temp.base() returns text language sql immutable as $$ select E'A😀 alpha middle omega\r\n' $$;
create function pg_temp.payload() returns jsonb language sql immutable as $$
  select jsonb_build_object('base',pg_temp.base(),'suggestions','[
    {"id":"first","from":4,"to":9,"expected":"alpha","insert":"ALPHA!","sourceIds":["revision:1"]},
    {"id":"last","from":17,"to":22,"expected":"omega","insert":"Ω","sourceIds":["revision:2"]}]'::jsonb,
    'provenance',jsonb_build_object('label','Imported document','base',pg_temp.base(),'proposed',E'A😀 ALPHA! middle Ω\r\n','annotations','[
      {"id":"revision:1","sourceId":"1","kind":"ins","author":"Original author","date":"2026-11-17","rawXml":"<w:ins w:id=\"1\"/>"},
      {"id":"revision:2","sourceId":"2","kind":"del"},
      {"id":"comment:1","kind":"comment","text":"On inserted text","anchor":{"projection":"proposed","from":4,"to":10,"quote":"ALPHA!"}}]'::jsonb))
$$;
create temp table results(name text primary key, data jsonb);
grant all on results to authenticated;

select table_privs_are('public','note_reviews','authenticated',array['SELECT'],'Members can only read review rows directly');
select table_privs_are('public','note_review_decisions','authenticated',array['SELECT'],'Decision history is append-only to clients');
select table_privs_are('public','note_reviews','anon',array[]::text[],'Anonymous callers have no review grants');
select table_privs_are('public','note_review_decisions','anon',array[]::text[],'Anonymous callers have no decision grants');
select function_privs_are('public','get_note_review',array['uuid','uuid'],'anon',array[]::text[],'Anonymous callers cannot use the read RPC');
select function_privs_are('public','save_note_review',array['uuid','uuid','uuid','bigint','bigint','uuid','jsonb'],'anon',array[]::text[],'Anonymous callers cannot save reviews');
select function_privs_are('public','decide_note_review',array['uuid','uuid','bigint','uuid','text','text'],'anon',array[]::text[],'Anonymous callers cannot decide reviews');
select function_privs_are('private','note_review_replay',array['uuid','uuid','bytea'],'authenticated',array[]::text[],'Receipts cannot bypass project authorization');

insert into auth.users(id,email) select pg_temp.person(who),who||'@example.test' from unnest(array['owner','editor','commenter','viewer','invited','other']) who;
insert into auth.oauth_clients(id,registration_type,redirect_uris,grant_types,client_name,token_endpoint_auth_method,client_type)
 values('a9000000-0000-4000-8000-000000000001','dynamic','https://agent.example/callback','authorization_code','Review test agent','none','public');
insert into public.projects(id,owner_id,title) values(pg_temp.project(),pg_temp.person('owner'),'Review tests');
insert into public.project_members(project_id,user_id,role,accepted_at) values
 (pg_temp.project(),pg_temp.person('editor'),'editor',now()),(pg_temp.project(),pg_temp.person('commenter'),'commenter',now()),
 (pg_temp.project(),pg_temp.person('viewer'),'viewer',now()),(pg_temp.project(),pg_temp.person('invited'),'editor',null);
set local role authenticated;
select pg_temp.act('owner');
select public.save_files(pg_temp.project(),gen_random_uuid(),jsonb_build_array(jsonb_build_object('op','put','path','note.mdx','content',pg_temp.base())));
select is(public.get_note_review(pg_temp.project(),pg_temp.file_id())->'review','null'::jsonb,'A file starts without a review');
insert into results values('create',public.save_note_review(pg_temp.project(),pg_temp.file_id(),pg_temp.review(),null,1,'b9000000-0000-4000-8000-000000000001',pg_temp.payload()));
select is((select data#>>'{review,version}' from results where name='create'),'1','A durable review starts at CAS version 1');
select is((select content from public.project_files where id=pg_temp.file_id()),pg_temp.base(),'Creating a review does not accept any source');
select is((select count(*)::int from public.file_versions where file_id=pg_temp.file_id()),1,'Creating a review creates no canonical file version');
select is(public.get_note_review(pg_temp.project(),pg_temp.file_id()),(select data from results where name='create'),'A fresh read recovers the exact durable review');
select is((select revision::int from public.projects where id=pg_temp.project()),2,'A review save advances the existing project change signal');
select is(public.save_note_review(pg_temp.project(),pg_temp.file_id(),pg_temp.review(),null,1,'b9000000-0000-4000-8000-000000000001',pg_temp.payload()),(select data from results where name='create'),'An import retry returns its exact original result');
select throws_ok($$select public.save_note_review(pg_temp.project(),pg_temp.file_id(),pg_temp.review(),null,1,'b9000000-0000-4000-8000-000000000001',pg_temp.payload()||'{"suggestions":[]}'::jsonb)$$,'22023',null,'A mutation ID cannot be reused for different source');
select throws_ok($$update public.note_reviews set payload='{}'$$,'42501',null,'Clients cannot bypass validation with direct updates');
select throws_ok($$delete from public.note_reviews$$,'42501',null,'Clients cannot permanently delete review history');
select throws_ok($$delete from public.note_review_decisions$$,'42501',null,'Clients cannot permanently delete decisions');
select throws_ok($$select public.finish_note_review(pg_temp.project(),pg_temp.review(),1,gen_random_uuid())$$,'22023',null,'A pending review cannot be closed');

select pg_temp.act('commenter');
select is((select count(*)::int from public.note_reviews),1,'Accepted commenters can read durable suggestions');
select is((select count(*)::int from public.note_review_decisions),1,'Accepted commenters can read decision history');
select throws_ok($$select public.save_note_review(pg_temp.project(),pg_temp.file_id(),pg_temp.review(),1,1,gen_random_uuid(),pg_temp.payload())$$,'42501',null,'Commenters cannot gain file or review write access');
select throws_ok($$select public.decide_note_review(pg_temp.project(),pg_temp.review(),1,gen_random_uuid(),'accept','first')$$,'42501',null,'Commenters cannot accept changes');
select pg_temp.act('viewer');
select is((public.get_note_review(pg_temp.project(),pg_temp.file_id())#>>'{review,id}'),pg_temp.review()::text,'Accepted viewers may read the shared review');
select throws_ok($$select public.decide_note_review(pg_temp.project(),pg_temp.review(),1,gen_random_uuid(),'reject',null)$$,'42501',null,'Viewers cannot reject suggestions');
select pg_temp.act('invited');
select is((select count(*)::int from public.note_reviews),0,'Unaccepted invitations grant no review rows');
select is((select count(*)::int from public.note_review_decisions),0,'Unaccepted invitations grant no decision rows');
select throws_ok($$select public.get_note_review(pg_temp.project(),pg_temp.file_id())$$,'42501',null,'Unaccepted invitees cannot call the read RPC');
select pg_temp.act('other');
select is((select count(*)::int from public.note_reviews),0,'An unrelated account cannot see another project review');
select is((select count(*)::int from public.note_review_decisions),0,'An unrelated account cannot see decision receipts');
select throws_ok($$select public.get_note_review(pg_temp.project(),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$,'42501',null,'Knowing a project UUID does not permit review reads');

select pg_temp.act('editor',true);
insert into results values('accepted',public.decide_note_review(pg_temp.project(),pg_temp.review(),1,'b9000000-0000-4000-8000-000000000002','accept','first'));
select is((select content from public.project_files where id=pg_temp.file_id()),E'A😀 ALPHA! middle omega\r\n','Acceptance maps UTF-16 offsets after an emoji and preserves CRLF');
select is((select data#>>'{review,version}' from results where name='accepted'),'2','Acceptance advances the review CAS once');
select is((select data#>>'{review,base_version}' from results where name='accepted'),'3','Acceptance uses the exact canonical saved version');
select is((select data#>>'{review,payload,suggestions,0,from}' from results where name='accepted'),'18','Acceptance rebases the remaining UTF-16 range');
select is((select data#>>'{file,content}' from results where name='accepted'),E'A😀 ALPHA! middle omega\r\n','Acceptance returns only its saved canonical snapshot');
select is((select data#>'{review,payload,provenance}' from results where name='accepted'),pg_temp.payload()->'provenance','Original metadata remains immutable after acceptance');
select is((select original_bundle from public.note_reviews where id=pg_temp.review()),pg_temp.payload(),'The complete original import remains archived');
select is((select count(*)::int from public.file_versions where file_id=pg_temp.file_id()),2,'Acceptance writes one ordinary recoverable file version');
select is((select revision::int from public.projects where id=pg_temp.project()),3,'Acceptance does not double-increment the project revision');
select is(public.decide_note_review(pg_temp.project(),pg_temp.review(),1,'b9000000-0000-4000-8000-000000000002','accept','first'),(select data from results where name='accepted'),'Acceptance retries return the exact original result');
select is((select count(*)::int from public.file_versions where file_id=pg_temp.file_id()),2,'A retried accept never writes a duplicate version');
select throws_ok($$select public.decide_note_review(pg_temp.project(),pg_temp.review(),1,gen_random_uuid(),'accept','last')$$,'40001',null,'An overlapping stale decision cannot overwrite the winning decision');
select throws_ok($$select public.decide_note_review(pg_temp.project(),pg_temp.review(),2,gen_random_uuid(),'accept','missing')$$,'22023',null,'An unknown suggestion cannot be accepted');
select throws_ok($$select public.save_note_review(pg_temp.project(),pg_temp.file_id(),pg_temp.review(),2,3,gen_random_uuid(),(select jsonb_set(payload,'{provenance,label}','"Changed label"'::jsonb) from public.note_reviews where id=pg_temp.review()))$$,'22023',null,'Even otherwise valid original provenance cannot be replaced through update');
select throws_ok($$select public.save_note_review(pg_temp.project(),pg_temp.file_id(),pg_temp.review(),1,3,gen_random_uuid(),(select payload from public.note_reviews where id=pg_temp.review()))$$,'40001',null,'A stale editor cannot overwrite the winning review state');
select is((select version::int from public.note_reviews where id=pg_temp.review()),2,'Refused updates leave review and canonical acceptance atomic');
select throws_ok($$delete from public.note_reviews$$,'42501',null,'OAuth-client sessions also have no permanent-delete grant');
insert into results values('rejected',public.decide_note_review(pg_temp.project(),pg_temp.review(),2,gen_random_uuid(),'reject',null));
select is((select data->'file' from results where name='rejected'),'null'::jsonb,'Rejection returns no canonical write');
select is((select count(*)::int from public.file_versions where file_id=pg_temp.file_id()),2,'Rejecting the remainder writes no canonical history');
select is((select jsonb_array_length(payload->'suggestions') from public.note_reviews where id=pg_temp.review()),0,'Reject all clears pending changes');
insert into results values('finished',public.finish_note_review(pg_temp.project(),pg_temp.review(),3,'b9000000-0000-4000-8000-000000000003'));
select is((select data#>>'{review,status}' from results where name='finished'),'closed','Finishing retains a closed review');
select is((public.get_note_review(pg_temp.project(),pg_temp.file_id())#>>'{review,status}'),'closed','The closed record remains readable');
select is((select original_bundle from public.note_reviews where id=pg_temp.review()),pg_temp.payload(),'Finishing retains original comments and all imported markup');
select is(public.finish_note_review(pg_temp.project(),pg_temp.review(),3,'b9000000-0000-4000-8000-000000000003'),(select data from results where name='finished'),'Finishing is idempotent after close');
select is(public.decide_note_review(pg_temp.project(),pg_temp.review(),1,'b9000000-0000-4000-8000-000000000002','accept','first'),(select data from results where name='accepted'),'A past acceptance remains retryable after later decisions and closure');
select is((select count(*)::int from public.note_review_decisions where review_id=pg_temp.review()),4,'The original save, accept, reject and finish remain append-only');

-- The same valid-base contract is enforced on the server, not just in Zod.
select pg_temp.act('owner');
select throws_ok($$select public.save_note_review(pg_temp.project(),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',gen_random_uuid(),null,3,gen_random_uuid(),jsonb_build_object('base',E'A😀 ALPHA! middle omega\r\n','suggestions','[]'::jsonb))$$,'40001',null,'A device-local UUID cannot stand in for the canonical file identity');
select throws_ok($$select public.save_note_review(pg_temp.project(),pg_temp.file_id(),gen_random_uuid(),null,3,gen_random_uuid(),jsonb_build_object('base',E'A😀 ALPHA! middle omega\r\n','suggestions','[{"id":"bad","from":2,"to":3,"expected":"😀","insert":"x"}]'::jsonb))$$,'22023',null,'A split-surrogate range is rejected at the SQL boundary');
select throws_ok($$select public.save_note_review(pg_temp.project(),pg_temp.file_id(),gen_random_uuid(),null,3,gen_random_uuid(),jsonb_build_object('base',E'A😀 ALPHA! middle omega\r\n','suggestions','[{"id":"bad","from":4,"to":5,"expected":"wrong","insert":"x"}]'::jsonb))$$,'22023',null,'A mismatched expected range is rejected');
select throws_ok($$select public.save_note_review(pg_temp.project(),pg_temp.file_id(),gen_random_uuid(),null,3,gen_random_uuid(),jsonb_build_object('base',E'A😀 ALPHA! middle omega\r\n','suggestions','[]'::jsonb,'unexpected',true))$$,'22023',null,'Unknown payload metadata is not silently discarded');
select throws_ok($$select public.save_note_review(pg_temp.project(),pg_temp.file_id(),gen_random_uuid(),null,3,gen_random_uuid(),jsonb_build_object('base',repeat('é',1048577),'suggestions','[]'::jsonb))$$,'22023',null,'Source limits count UTF-8 bytes');

insert into results values('new',public.save_note_review(pg_temp.project(),pg_temp.file_id(),'a9000000-0000-4000-8000-000000000004',null,3,gen_random_uuid(),jsonb_build_object('base',E'A😀 ALPHA! middle omega\r\n','suggestions','[{"id":"emoji","from":1,"to":3,"expected":"😀","insert":"🙂"}]'::jsonb)));
select is((public.get_note_review(pg_temp.project(),pg_temp.file_id())#>>'{review,id}'),'a9000000-0000-4000-8000-000000000004','A new review can start while completed history remains');
select public.save_files(pg_temp.project(),gen_random_uuid(),jsonb_build_array(jsonb_build_object('op','move','path','note.mdx','to','moved.mdx','base_version',3)));
select is((public.get_note_review(pg_temp.project(),pg_temp.file_id())#>>'{review,path}'),'note.mdx','Moving a note never silently retargets an earlier review');
select throws_ok($$select public.decide_note_review(pg_temp.project(),'a9000000-0000-4000-8000-000000000004',1,gen_random_uuid(),'accept','emoji')$$,'40001',null,'A moved file blocks acceptance without losing proposals');
select is((select count(*)::int from public.note_review_decisions where review_id='a9000000-0000-4000-8000-000000000004'),1,'Failed acceptance leaves no decision receipt');
select lives_ok($$select public.decide_note_review(pg_temp.project(),'a9000000-0000-4000-8000-000000000004',1,gen_random_uuid(),'reject',null)$$,'A stale review can still be rejected for recovery');
select lives_ok($$select public.finish_note_review(pg_temp.project(),'a9000000-0000-4000-8000-000000000004',2,gen_random_uuid())$$,'A stale empty review can be closed without touching its target');

-- A complete emoji inside the chosen patch is accepted, then revocation and
-- canonical deletion prevent new decisions without destroying review history.
insert into results values('emoji',public.save_note_review(pg_temp.project(),pg_temp.file_id(),'a9000000-0000-4000-8000-000000000005',null,(select version from public.project_files where id=pg_temp.file_id()),gen_random_uuid(),jsonb_build_object('base',E'A😀 ALPHA! middle omega\r\n','suggestions','[{"id":"emoji","from":1,"to":3,"expected":"😀","insert":"🙂"}]'::jsonb)));
select lives_ok($$select public.decide_note_review(pg_temp.project(),'a9000000-0000-4000-8000-000000000005',1,gen_random_uuid(),'accept',null)$$,'A complete surrogate pair can be accepted');
select is((select content from public.project_files where id=pg_temp.file_id()),E'A🙂 ALPHA! middle omega\r\n','The SQL applier preserves the exact emoji replacement');
select lives_ok($$select public.save_note_review(pg_temp.project(),pg_temp.file_id(),'a9000000-0000-4000-8000-000000000005',2,(select version from public.project_files where id=pg_temp.file_id()),gen_random_uuid(),jsonb_build_object('base',E'A🙂 ALPHA! middle omega\r\n','suggestions',jsonb_build_array(jsonb_build_object('id','pending-delete','from',0,'to',1,'expected','A','insert','B'))))$$,'Editing updates the shared pending review without saving canonical source');
select public.save_files(pg_temp.project(),gen_random_uuid(),jsonb_build_array(jsonb_build_object('op','delete','path','moved.mdx','base_version',(select version from public.project_files where id=pg_temp.file_id()))));
select throws_ok($$select public.decide_note_review(pg_temp.project(),'a9000000-0000-4000-8000-000000000005',3,gen_random_uuid(),'accept',null)$$,'40001',null,'Deleting a target prevents acceptance atomically');
select is((select count(*)::int from public.note_reviews where id='a9000000-0000-4000-8000-000000000005'),1,'The deleted target retains its complete review for recovery');
select is((select jsonb_array_length(payload->'suggestions') from public.note_reviews where id='a9000000-0000-4000-8000-000000000005'),1,'A failed accept after deletion preserves its pending proposal');
reset role;
delete from public.project_members where project_id=pg_temp.project() and user_id=pg_temp.person('editor');
set local role authenticated;
select pg_temp.act('editor');
select is((select count(*)::int from public.note_reviews),0,'Revoked editors immediately lose review reads');
select throws_ok($$select public.get_note_review(pg_temp.project(),pg_temp.file_id())$$,'42501',null,'Revocation is rechecked by the read function');
select throws_ok($$select public.decide_note_review(pg_temp.project(),pg_temp.review(),1,'b9000000-0000-4000-8000-000000000002','accept','first')$$,'42501',null,'Revocation also blocks replay of an earlier authorized mutation');
select pg_temp.act('owner');
select public.archive_project(pg_temp.project());
select throws_ok($$select public.finish_note_review(pg_temp.project(),'a9000000-0000-4000-8000-000000000005',2,gen_random_uuid())$$,'55000',null,'Archived projects block new review mutations');
select is(public.save_note_review(pg_temp.project(),pg_temp.file_id(),pg_temp.review(),null,1,'b9000000-0000-4000-8000-000000000001',pg_temp.payload()),(select data from results where name='create'),'An owner can replay an existing import after archive');
select * from finish();
rollback;
