SET local check_function_bodies = off;

CREATE TABLE "public"."deleted_projects" (
  "user_id"    uuid                     NOT NULL,
  "project_id" uuid                     NOT NULL,
  "deleted_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "deleted_projects_pkey" PRIMARY KEY (user_id, project_id)
);

ALTER TABLE "public"."deleted_projects"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."deleted_projects" FROM "anon";

CREATE OR REPLACE FUNCTION private.delete_project (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
begin
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can permanently delete a project; agents can archive it'
      using errcode = '42501';
  end if;
  select * into p from public.projects where id = delete_project.project_id for update;
  if p.id is null or p.owner_id <> uid then
    raise exception 'Only the project owner can permanently delete it' using errcode = '42501';
  end if;
  -- The people in it hear that its owner deleted it (see deleted_projects).
  delete from public.deleted_projects d where d.deleted_at < now() - interval '90 days';
  insert into public.deleted_projects (user_id, project_id)
  select m.user_id, p.id
  from public.project_members m
  where m.project_id = p.id and m.accepted_at is not null
  on conflict on constraint deleted_projects_pkey do update set deleted_at = excluded.deleted_at;
  delete from public.projects where id = p.id;
  return jsonb_build_object('id', p.id, 'deleted', true);
end;
$function$;

ALTER TABLE "public"."deleted_projects"
  ADD CONSTRAINT "deleted_projects_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE POLICY "People can see which projects they were in were deleted" ON "public"."deleted_projects"
  FOR SELECT
  TO "authenticated"
  USING ((user_id = ( SELECT auth.uid() AS uid)));

REVOKE ALL ON TABLE "public"."deleted_projects" FROM "authenticated";

GRANT SELECT ON TABLE "public"."deleted_projects" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."deleted_projects" TO "postgres";

REVOKE ALL ON TABLE "public"."deleted_projects" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."deleted_projects" TO "service_role";
