/**
 * The drawings and diagrams that did not fit in show_file's result
 * (`deferred`, fileView.ts MAX_META_CHARS). Where the host lets the card
 * call tools, it loads each with card_embed, the view's own tool, for its
 * path in the same project, one at a time in the note's order, and shows it
 * where its link was, as that result has it: its SVG, or what the card
 * draws a diagram from (cardDiagrams.ts). Both come in the result's
 * structuredContent, since a host may leave `_meta` out of the result of a
 * call the card makes. Until then its embed says it is loading. A call that
 * fails, or that the host has not answered in 20 s, and a host that does not
 * let the card call tools, leave its link. Once the host has not answered
 * one, the rest leave theirs at once, with no more calls. A newer file for
 * the card stops the calls.
 */
import { useEffect, useMemo, useState } from "react"
import type { HostBridge } from "./bridge"
import { parseEmbedResult, parseImagePreviewResult, type CardEmbed, type CardFile, type LoadedEmbed } from "./toolResult"
import { cardImageBytes, type CardImagePixels } from './cardImages';

/** How long the card waits for one drawing or diagram before it leaves its link. */
const LOAD_TIMEOUT_MS = 20_000

/** Each deferred path's own result, or null where it could not be loaded. */
type Loaded = ReadonlyMap<string, LoadedEmbed | null>

const NONE: Loaded = new Map()
const imageIdentity = (reference:{path:string;revision?:number}) => `${reference.path}\0${reference.revision ?? 'current'}`;

/** The paths of `file`'s deferred embeds, each once, in the note's order. */
const deferredPaths = (file: CardFile): string[] => [...new Set(file.embeds.flatMap((embed) => (embed?.status === "deferred" ? [embed.path] : [])))]

/** What `within` settles to when no answer came in time. */
const NO_ANSWER = Symbol("no answer")

/** What `promise` settles to, or NO_ANSWER once `ms` pass without it. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof NO_ANSWER> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<typeof NO_ANSWER>((resolve) => {
    timer = setTimeout(() => resolve(NO_ANSWER), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/**
 * `file` with each deferred embed as its own result shows it, once loaded,
 * and until then as loading where the card loads it. The same file when it
 * has none.
 */
function withLoaded(file: CardFile, loaded: Loaded, loading: boolean): CardFile {
  if (!file.embeds.some((embed) => embed?.status === "deferred")) return file
  const svgs = { ...file.svgs }
  const diagrams = { ...file.diagrams }
  const embeds = file.embeds.map((embed): CardEmbed | null => {
    if (embed?.status !== "deferred") return embed
    const got = loaded.get(embed.path)
    if (got === undefined) return loading ? { ...embed, status: "loading" } : embed
    if (!got) return embed
    if (got.svg) svgs[embed.path] = got.svg
    if (got.diagram) diagrams[embed.path] = got.diagram
    return { ...embed, status: got.status }
  })
  return { ...file, embeds, svgs, diagrams }
}

/** `file` with its deferred drawings and diagrams loaded through `host`: null where the card cannot call tools. */
function useLoadedEmbeds(file: CardFile | null, host: HostBridge | null): CardFile | null {
  const [loaded, setLoaded] = useState<{ file: CardFile; got: Loaded } | null>(null)
  useEffect(() => {
    if (!file || !host) return
    let stopped = false
    void (async () => {
      const paths = deferredPaths(file)
      for (const [index, path] of paths.entries()) {
        let answer: unknown = null
        try {
          answer = await within(host.callTool("card_embed", { project_id: file.projectId, path }), LOAD_TIMEOUT_MS)
        } catch {
          // Refused or failed: the link stays.
        }
        if (stopped) return
        // Not answered in time: the host stopped answering, so this link and the rest stay at once, with no more calls.
        const silent = answer === NO_ANSWER
        const got = silent ? null : parseEmbedResult(answer, path)
        setLoaded((current) => {
          const next = new Map(current?.file === file ? current.got : NONE)
          for (const each of silent ? paths.slice(index) : [path]) next.set(each, got)
          return { file, got: next }
        })
        if (silent) return
      }
    })()
    return () => {
      stopped = true
    }
  }, [file, host])
  return useMemo(() => file && withLoaded(file, loaded?.file === file ? loaded.got : NONE, host !== null), [file, loaded, host])
}

/** Image previews load sequentially, with the same stop-on-silent-host behavior as drawing embeds. */
export function useLoadedFile(file:CardFile|null,host:HostBridge|null):CardFile|null {
  const embeds = useLoadedEmbeds(file,host);
  const [loaded,setLoaded] = useState<{file:CardFile;images:ReadonlyMap<string,CardImagePixels|null>}|null>(null);
  useEffect(() => {
    if (!file || !host) return;
    let stopped = false;
    void (async () => {
      const jobs = [...new Map((file.imageRefs ?? []).filter(reference => !file.images?.[reference.key] && reference.status !== 'missing').map(reference => [imageIdentity(reference),{path:reference.path,revision:reference.revision}])).values()];
      let bytes = Object.values(file.images ?? {}).reduce((total,pixels) => total + cardImageBytes(pixels),0);
      if (file.kind === 'image' && !file.images?.[file.path] && !jobs.some(job => job.path === file.path)) jobs.push({path:file.path,revision:file.version ?? undefined});
      for (const [index,job] of jobs.entries()) {
        const {path,revision} = job;
        let answer:unknown = null;
        try { answer = await within(host.callTool('get_image_preview',{project_id:file.projectId,path,...(revision === undefined ? {} : {revision})}),LOAD_TIMEOUT_MS); } catch { /* keep the explicit app fallback */ }
        if (stopped) return;
        const silent = answer === NO_ANSWER;
        const pixels = silent ? null : parseImagePreviewResult(answer,path);
        const cost = pixels ? cardImageBytes(pixels) * Math.max(1,(file.imageRefs ?? []).filter(reference => imageIdentity(reference) === imageIdentity(job) && !file.images?.[reference.key]).length) : 0;
        const full = bytes + cost > 2 * 1024 * 1024;
        setLoaded(current => {
          const images = new Map(current?.file === file ? current.images : []);
          for (const each of silent || full ? jobs.slice(index) : [job]) images.set(imageIdentity(each),full ? null : pixels);
          return {file,images};
        });
        if (silent || full) return;
        bytes += cost;
      }
    })();
    return () => { stopped = true; };
  }, [file,host]);
  return useMemo(() => {
    if (!file || !embeds) return null;
    const got = loaded?.file === file ? loaded.images : new Map<string,CardImagePixels|null>();
    if (!(file.imageRefs?.length || file.kind === 'image')) return embeds;
    const images = {...file.images};
    const imageRefs = (file.imageRefs ?? []).map(reference => {
      const pixels = got.get(imageIdentity(reference));
      if (pixels) images[reference.key] = pixels;
      return images[reference.key] ? {...reference,status:'ready' as const} :
        !host || got.has(imageIdentity(reference)) ? reference : {...reference,status:'loading' as const};
    });
    const standalone = got.get(imageIdentity({path:file.path,revision:file.version ?? undefined}));
    if (file.kind === 'image' && standalone) images[file.path] = standalone;
    return {...embeds,images,imageRefs};
  }, [file,embeds,loaded,host]);
}
