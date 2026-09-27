-- Written by hand: data, not schema. A D2 diagram's generated canvas
-- (flow.excalidraw next to flow.d2) now gets no passages of its own, since its
-- words are the diagram's; the `embed` function decides. Canvases indexed
-- before now are queued once so their passages are removed.
select pgmq.send('file_passages', jsonb_build_object('fileId', f.id))
from public.project_files f
where f.path ~* '\.excalidraw$'
  and exists (
    select 1 from public.project_files d
    where d.project_id = f.project_id
      and lower(d.path) = lower(regexp_replace(f.path, '\.excalidraw$', '.d2', 'i'))
  );
