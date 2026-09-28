SET local check_function_bodies = off;

REVOKE ALL ON TABLE "public"."comments" FROM "authenticated";

CREATE TABLE "private"."deleted_comment_threads" (
  "project_id" uuid                     NOT NULL,
  "id"         uuid                     NOT NULL,
  "deleted_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "deleted_comment_threads_pkey" PRIMARY KEY (project_id, id)
);

ALTER TABLE "private"."deleted_comment_threads"
  ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION private.add_comment (
  project_id   uuid,
  thread_id    uuid,
  file_id      uuid,
  file_version bigint,
  anchor       jsonb,
  body         text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  t public.comment_threads;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if add_comment.project_id is null or add_comment.thread_id is null or add_comment.file_id is null
    or add_comment.file_version is null or add_comment.file_version <= 0 then
    raise exception 'Project, thread and file ids and a positive file version are required' using errcode = '22023';
  end if;
  perform private.check_comment_body(add_comment.body);
  if not coalesce(private.is_valid_comment_anchor(add_comment.anchor), false) then
    raise exception 'Invalid anchor' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(add_comment.project_id, true);

  select * into t from public.comment_threads ct where ct.id = add_comment.thread_id;
  if t.id is not null then
    if t.project_id = p.id and t.file_id = add_comment.file_id and t.created_by = uid then
      return jsonb_build_object('revision', p.revision, 'thread', private.thread_json(t));
    end if;
    raise exception 'This comment id was already used' using errcode = '22023';
  end if;
  if exists (
    select 1 from private.deleted_comment_threads d where d.project_id = p.id and d.id = add_comment.thread_id
  ) then
    raise exception 'This comment was deleted' using errcode = '22023';
  end if;

  if p.archived_at is not null then
    raise exception 'Project is archived' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.project_files f where f.id = add_comment.file_id and f.project_id = p.id
  ) then
    raise exception 'No such file in this project' using errcode = '22023';
  end if;
  if (select count(*) from public.comment_threads ct
      where ct.project_id = p.id and ct.file_id = add_comment.file_id) >= 1000 then
    raise exception 'A file can have at most 1000 comment threads' using errcode = '54000';
  end if;
  if (select count(*) from public.comments c where c.project_id = p.id) >= 10000 then
    raise exception 'A project can hold at most 10000 comments' using errcode = '54000';
  end if;

  insert into public.comment_threads (id, project_id, file_id, file_version, anchor, created_by)
  values (add_comment.thread_id, p.id, add_comment.file_id, add_comment.file_version, add_comment.anchor, uid)
  returning * into t;
  insert into public.comments (thread_id, project_id, author_id, agent_client_id, body)
  values (t.id, p.id, uid, nullif((select auth.jwt()) ->> 'client_id', ''), add_comment.body);

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'thread', private.thread_json(t));
end;
$function$;

CREATE OR REPLACE FUNCTION private.delete_comment (
  comment_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  c public.comments;
  thread_deleted boolean := false;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can delete comments; agents can resolve them' using errcode = '42501';
  end if;
  if delete_comment.comment_id is null then
    raise exception 'Comment id required' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(
    private.comment_project((select cm.project_id from public.comments cm where cm.id = delete_comment.comment_id))
  );
  select * into c from public.comments cm where cm.id = delete_comment.comment_id and cm.project_id = p.id;
  if c.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if c.author_id is distinct from uid and p.owner_id <> uid then
    raise exception 'Only its author or the project owner can delete a comment' using errcode = '42501';
  end if;
  if c.deleted_at is not null then
    return jsonb_build_object('revision', p.revision, 'comment_id', c.id, 'thread_deleted', false);
  end if;

  update public.comments cm set body = null, deleted_at = now() where cm.id = c.id;
  if not exists (
    select 1 from public.comments cm where cm.thread_id = c.thread_id and cm.deleted_at is null
  ) then
    delete from public.comment_threads ct where ct.id = c.thread_id;
    insert into private.deleted_comment_threads (project_id, id) values (p.id, c.thread_id)
      on conflict do nothing;
    thread_deleted := true;
  end if;

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'comment_id', c.id, 'thread_deleted', thread_deleted);
end;
$function$;

CREATE OR REPLACE FUNCTION private.delete_comment_thread (
  thread_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  t public.comment_threads;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can delete comments; agents can resolve them' using errcode = '42501';
  end if;
  if delete_comment_thread.thread_id is null then
    raise exception 'Thread id required' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(
    private.comment_project((select ct.project_id from public.comment_threads ct where ct.id = delete_comment_thread.thread_id))
  );
  select * into t from public.comment_threads ct where ct.id = delete_comment_thread.thread_id and ct.project_id = p.id;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if p.owner_id <> uid and (
    t.created_by is distinct from uid
    or exists (
      select 1 from public.comments cm
      where cm.thread_id = t.id and cm.deleted_at is null and cm.author_id is distinct from uid
    )
  ) then
    raise exception 'Only the project owner can delete a thread with other people''s comments' using errcode = '42501';
  end if;

  delete from public.comment_threads ct where ct.id = t.id;
  insert into private.deleted_comment_threads (project_id, id) values (p.id, t.id)
    on conflict do nothing;
  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'thread_id', t.id, 'deleted', true);
end;
$function$;

CREATE OR REPLACE FUNCTION private.edit_comment (
  comment_id uuid,
  body       text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  c public.comments;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can edit comments; agents can reply' using errcode = '42501';
  end if;
  if edit_comment.comment_id is null then
    raise exception 'Comment id required' using errcode = '22023';
  end if;
  perform private.check_comment_body(edit_comment.body);

  p := private.lock_project_for_comment(
    private.comment_project((select cm.project_id from public.comments cm where cm.id = edit_comment.comment_id))
  );
  select * into c from public.comments cm where cm.id = edit_comment.comment_id and cm.project_id = p.id;
  if c.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if c.author_id is distinct from uid then
    raise exception 'Only its author can edit a comment' using errcode = '42501';
  end if;
  if c.deleted_at is not null then
    raise exception 'This comment was deleted' using errcode = '22023';
  end if;
  if c.body = edit_comment.body then
    return jsonb_build_object('revision', p.revision, 'comment', private.comment_json(c));
  end if;

  update public.comments cm set body = edit_comment.body, edited_at = now()
  where cm.id = c.id
  returning * into c;
  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'comment', private.comment_json(c));
end;
$function$;

ALTER TABLE "private"."deleted_comment_threads"
  ADD CONSTRAINT "deleted_comment_threads_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."deleted_comment_threads" TO "postgres";

REVOKE ALL ("author_id") ON TABLE "public"."comments" FROM "authenticated";

GRANT SELECT ("author_id") ON TABLE "public"."comments" TO "authenticated";

REVOKE ALL ("body") ON TABLE "public"."comments" FROM "authenticated";

GRANT SELECT ("body") ON TABLE "public"."comments" TO "authenticated";

REVOKE ALL ("created_at") ON TABLE "public"."comments" FROM "authenticated";

GRANT SELECT ("created_at") ON TABLE "public"."comments" TO "authenticated";

REVOKE ALL ("deleted_at") ON TABLE "public"."comments" FROM "authenticated";

GRANT SELECT ("deleted_at") ON TABLE "public"."comments" TO "authenticated";

REVOKE ALL ("edited_at") ON TABLE "public"."comments" FROM "authenticated";

GRANT SELECT ("edited_at") ON TABLE "public"."comments" TO "authenticated";

REVOKE ALL ("id") ON TABLE "public"."comments" FROM "authenticated";

GRANT SELECT ("id") ON TABLE "public"."comments" TO "authenticated";

REVOKE ALL ("project_id") ON TABLE "public"."comments" FROM "authenticated";

GRANT SELECT ("project_id") ON TABLE "public"."comments" TO "authenticated";

REVOKE ALL ("thread_id") ON TABLE "public"."comments" FROM "authenticated";

GRANT SELECT ("thread_id") ON TABLE "public"."comments" TO "authenticated";
