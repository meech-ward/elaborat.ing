import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/features/auth'
import { Banner, CommentComposer, CommentThread, CommentsPanel } from '@/features/design-system'
import { noteMarks, notePlaces } from '@/features/comments/noteMarks'
import { sectionAnchor, textAnchor, type CommentAnchor } from '@/features/comments/placement'
import { threadViews, fileNoun } from '@/features/comments/ui/threadViews'
import type { NoteCommentRequest } from '@/features/comments/useNoteComments'
import type { RenderedComments, RenderedEditorApi } from '@/features/rendered'
import { readSharedDiscussion, shareCommentRPC, SharedFileUnavailable, type SharedBundle, type SharedDiscussion } from './publicRemote'
import { forgetShareDraft, readShareDraft, saveShareDraft, type ShareCommentDraft } from './commentDraft'
import type { RemoteThread } from '@/features/comments/remote'

const NO_THREADS: RemoteThread[] = []
function newDraft(bundle: SharedBundle, anchor: CommentAnchor): ShareCommentDraft {
  return {shareId: bundle.share.id, fileId: bundle.share.file_id, fileVersion: bundle.share.version,
    threadId: crypto.randomUUID(), commentId: crypto.randomUUID(), anchor, body: '', scroll: window.scrollY, savedAt: Date.now()}
}

/** Link discussion uses existing anchors and UI, with no project membership or private threads. */
export function useSharedDiscussion(token: string, bundle: SharedBundle, onUnavailable: () => void) {
  const auth = useAuth()
  const userId = auth.status === 'ready' ? auth.user.id : null
  const root = bundle.files.find(file => file.id === bundle.share.file_id)!
  const [loadedDiscussion, setDiscussion] = useState<{viewer: string | null; value: SharedDiscussion} | null>(null)
  const discussion = loadedDiscussion?.viewer === userId ? loadedDiscussion.value : null
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<ShareCommentDraft | null>(() => readShareDraft(bundle.share.id))
  const [open, setOpen] = useState(draft !== null)
  const [active, setActive] = useState<string | null>(null)
  const apiRef = useRef<RenderedEditorApi | null>(null)
  const pending = useRef(false)
  const queued = useRef(false)
  const mounted = useRef(true)
  const unavailable = useRef(onUnavailable)
  const refreshCurrent = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {unavailable.current = onUnavailable}, [onUnavailable])
  const refresh = useCallback(async () => {
    if (pending.current) {queued.current = true; return}
    pending.current = true
    try {
      const next = await readSharedDiscussion(token)
      if (!mounted.current) return
      if (next.share_id !== bundle.share.id || next.file_id !== root.id) throw new SharedFileUnavailable()
      setDiscussion({viewer: userId, value: next}); setError(null)
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof SharedFileUnavailable) {setDiscussion(null); unavailable.current()}
      setError(cause instanceof Error ? cause.message : 'Comments could not load.')
    } finally {
      pending.current = false
      if (queued.current && mounted.current) {queued.current = false; window.setTimeout(() => void refreshCurrent.current(), 0)}
    }
  }, [token, bundle.share.id, root.id, userId])
  useEffect(() => {refreshCurrent.current = refresh}, [refresh])
  useEffect(() => {
    mounted.current = true
    const initial = window.setTimeout(() => void refresh(), 0)
    const interval = window.setInterval(() => {if (!document.hidden) void refresh()}, 15_000)
    const focus = () => void refresh()
    window.addEventListener('focus', focus)
    window.addEventListener('online', focus)
    return () => {mounted.current = false; clearTimeout(initial); clearInterval(interval); window.removeEventListener('focus', focus); window.removeEventListener('online', focus)}
  }, [refresh, userId, bundle.share.revision])
  const restored = useRef(false)
  const restoringSignIn = useRef(draft !== null)
  useEffect(() => {
    if (!restoringSignIn.current || restored.current || !draft) return
    let stopped = false
    let timer = 0
    const restore = async () => {
      const needsRenderer = draft.sourceOffset !== undefined || draft.anchor.kind === 'text' || draft.anchor.kind === 'section'
      const ready = needsRenderer ? await apiRef.current?.place() : true
      if (stopped) return
      if (!ready) {timer = window.setTimeout(() => void restore(), 500); return}
      restored.current = true
      window.scrollTo({top: draft.scroll})
      if (draft.anchor.kind === 'text' || draft.anchor.kind === 'section') apiRef.current?.revealRange(draft.anchor.position.start, draft.anchor.position.end, false)
      else if (draft.sourceOffset !== undefined && root.content.length) {
        // revealRange highlights a nonempty source range. A reading position
        // can be a caret or EOF, so reveal its nearest character.
        const from = Math.max(0, Math.min(root.content.length - 1, draft.sourceOffset))
        const width = (root.content.codePointAt(from) ?? 0) > 0xffff ? 2 : 1
        apiRef.current?.revealRange(from, Math.min(root.content.length, from + width), false)
      }
    }
    timer = window.setTimeout(() => void restore(), 500)
    return () => {stopped = true; clearTimeout(timer)}
  }, [draft, root.content])

  const start = (anchor: CommentAnchor = {kind: 'document'}) => {
    setDraft(newDraft(bundle, anchor))
    setOpen(true)
  }
  const requestComment = (request: NoteCommentRequest, source: string) => {
    try {
      if (source !== root.content) throw new Error('The file changed. Select the text again.')
      if (request.kind === 'section') start(sectionAnchor(source, request.offset))
      else {
        let {from, to} = request
        while (from < to && /\s/.test(source[from])) from++
        while (to > from && /\s/.test(source[to - 1])) to--
        if (from >= to || to - from > 5000) throw new Error('Select between 1 and 5,000 characters to comment on.')
        start(textAnchor(source, from, to))
      }
      setError(null)
    } catch (cause) {setError(cause instanceof Error ? cause.message : 'Select some text to comment on.'); setOpen(true)}
  }
  const login = async (next: ShareCommentDraft): Promise<never> => {
    const place = await apiRef.current?.place()
    const sourceOffset = place ? 'top' in place ? place.top : place.selection.head : undefined
    try {saveShareDraft({...next, sourceOffset})} catch {throw new Error('Your browser could not keep this draft for sign-in. Copy your comment, sign in, then paste it here.')}
    window.location.assign(`/sign-in?next=${encodeURIComponent(`/s/${token}`)}`)
    // The page is leaving. Keep the composer pending so navigation does not
    // clear the draft or show an error for a successful sign-in handoff.
    return new Promise<never>(() => {})
  }
  const mutate = async (name: string, args: Record<string, unknown>) => {
    if (!userId) throw new Error('Sign in to post a comment.')
    await shareCommentRPC(name, {token, ...args}, userId)
    await refresh()
  }
  const submit = async (body: string) => {
    if (!draft) return
    const current = {...draft, body}
    if (!userId) return login(current)
    if (current.replyTo) await mutate('reply_file_share_comment', {thread_id: current.replyTo, comment_id: current.commentId, body})
    else await mutate('add_file_share_comment', {thread_id: current.threadId, comment_id: current.commentId,
      file_version: current.fileVersion, anchor: current.anchor, body})
    forgetShareDraft(bundle.share.id)
    setDraft(activeDraft => activeDraft?.commentId === current.commentId ? null : activeDraft)
  }
  const threads = discussion?.threads ?? NO_THREADS
  const places = useMemo(() => notePlaces(threads, root.content), [threads, root.content])
  const marks = useMemo(() => noteMarks(threads, places, active, draft ? {anchor: draft.anchor, source: root.content} : null), [threads, places, active, draft, root.content])
  const views = threadViews(threads, places, {userId, owner: discussion?.can_moderate ?? false}, fileNoun(root.path))
  const canComment = !bundle.share.archived
  const select = (id: string, focus = false) => {
    setActive(id); setOpen(true)
    const range = places.get(id)?.range
    if (range) apiRef.current?.revealRange(range.start, range.end, focus)
    requestAnimationFrame(() => document.getElementById(`shared-thread-${id}`)?.scrollIntoView({block: 'nearest'}))
  }
  const [replyIds] = useState(() => new Map<string, string>())
  const reply = async (threadId: string, body: string) => {
    let id = replyIds.get(threadId)
    if (!id) {id = crypto.randomUUID(); replyIds.set(threadId, id)}
    if (!userId) return login({...newDraft(bundle, threads.find(t => t.id === threadId)!.anchor), threadId, commentId: id, replyTo: threadId, body})
    await mutate('reply_file_share_comment', {thread_id: threadId, comment_id: id, body})
    replyIds.delete(threadId)
  }
  const renderThread = (view: (typeof views.open)[number]) => <SharedDiscussionThread key={view.id} view={view} active={active === view.id}
    canComment={canComment} canResolve={Boolean(userId && (view.own || discussion?.can_moderate))} signedIn={userId !== null}
    onSelect={select} onReply={reply} mutate={mutate} />
  const comments: RenderedComments = {marks, source: root.content, canComment, onComment: requestComment, onOpen: select}
  const panel = open ? <aside aria-label="Shared file comments" className="min-w-0 rounded-xl border border-border bg-panel lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:w-96 lg:overflow-y-auto">
    <p className="px-4 pt-4 text-xs text-muted-foreground">Visible to anyone with this link. Private project comments stay private.</p>
    {!userId && canComment ? <p className="px-4 pt-2 text-xs text-muted-foreground">You can read comments here. Posting will ask you to sign in.</p> : null}
    {error ? <Banner tone="danger" className="m-3">{error}</Banner> : null}
    <CommentsPanel onClose={() => setOpen(false)} fileNoun={fileNoun(root.path)} openThreads={views.open.map(renderThread)} resolvedThreads={views.resolved.map(renderThread)}
      status={discussion ? 'ready' : error ? 'error' : 'loading'} onRetry={() => void refresh()}
      readOnly={canComment ? false : 'This project is archived. Comments are read only.'}
      onCommentOnFile={canComment ? () => start() : undefined}
      draft={draft ? <div className="p-3"><p className="mb-2 text-sm font-medium">{draft.replyTo ? 'Reply' : draft.anchor.kind === 'document' ? 'Comment on the whole file' : 'Comment on selected text'}</p>
        {(draft.anchor.kind === 'text' || draft.anchor.kind === 'section') ? <blockquote className="mb-3 line-clamp-3 border-l-2 border-accent-line pl-3 text-sm text-muted-foreground">{draft.anchor.quote.exact}</blockquote> : null}
        <CommentComposer key={draft.commentId} label="New comment" value={draft.body}
          onValueChange={body => setDraft(activeDraft => activeDraft?.commentId === draft.commentId ? {...activeDraft, body} : activeDraft)}
          submitLabel={userId ? draft.replyTo ? 'Reply' : 'Comment' : 'Sign in to post'} maxLength={10_000}
          disabledReason={canComment ? undefined : 'This project is archived.'} onSubmit={submit}
          onCancel={() => {forgetShareDraft(bundle.share.id); setDraft(null)}} autoFocus />
      </div> : undefined} />
  </aside> : null
  return {comments, apiRef, panel, open, toggle: () => setOpen(value => !value), start: () => start(), canComment}
}

function SharedDiscussionThread({view, active, canComment, canResolve, signedIn, onSelect, onReply, mutate}: {
  view: ReturnType<typeof threadViews>['open'][number]; active: boolean; canComment: boolean; canResolve: boolean; signedIn: boolean;
  onSelect: (id: string, focus: boolean) => void;
  onReply: (id: string, body: string) => Promise<unknown>;
  mutate: (name: string, args: Record<string, unknown>) => Promise<void>;
}) {
  return <CommentThread id={`shared-thread-${view.id}`} anchor={view.anchor} comments={view.comments} resolved={view.resolved}
    active={active} canWrite={canComment} onSelect={() => onSelect(view.id, true)}
    onResolve={canResolve ? () => mutate('resolve_file_share_thread', {thread_id: view.id, resolved: true}) : undefined}
    onReopen={canResolve ? () => mutate('resolve_file_share_thread', {thread_id: view.id, resolved: false}) : undefined}
    onReply={body => onReply(view.id, body)}
    onEdit={signedIn ? (commentId, body) => mutate('edit_file_share_comment', {comment_id: commentId, body}) : undefined}
    onDelete={signedIn ? commentId => mutate('delete_file_share_comment', {comment_id: commentId}) : undefined} />
}
