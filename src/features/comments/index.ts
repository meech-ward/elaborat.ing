// Public entry point for comments: the anchors and where they are now
// (anchoring.ts, placement.ts), the database adapter and the per-project
// store (remote.ts, store.ts), what the panel and the file on screen
// share (controller.ts, read in React through context.tsx), and what a
// note's views and a drawing's canvas mark (noteMarks.ts, canvasPins.ts).

export { anchorRange, describeRange, type TextPositionSelector, type TextQuoteSelector, type TextRange } from "./anchoring"
export { anchorView, headingWords } from "./anchorView"
export { canvasPins, canvasPlaces, nextPinThread, type CanvasElement, type CanvasPin } from "./canvasPins"
export {
  NEEDS_CONNECTION,
  ProjectCommentsProvider,
  useCommentsUi,
  useFileThreads,
  useProjectComments,
  type ProjectCommentsValue,
} from "./context"
export {
  CommentsController,
  type CommentFile,
  type CommentRequest,
  type CommentTarget,
  type CommentsUiState,
  type ThreadPlace,
} from "./controller"
export { DRAFT_MARK, noteMarks, notePlace, notePlaces, type CommentMark } from "./noteMarks"
export {
  MAX_QUOTE_LENGTH,
  elementLabel,
  isHeadingLine,
  placeAnchor,
  placeTextAnchor,
  sectionAnchor,
  textAnchor,
  type CommentAnchor,
  type ElementAnchor,
  type Placement,
  type TextAnchor,
} from "./placement"
export { SupabaseCommentsRemote, offline, type CommentList, type CommentsRemote, type NewThread, type RemoteComment, type RemoteThread } from "./remote"
export { ProjectComments, type CommentsStatus } from "./store"
export { useCanvasComments, type CanvasCommentsProps } from "./useCanvasComments"
export { useNoteComments, type NoteCommentRequest, type NoteComments } from "./useNoteComments"
export { CommentsGuestProvider, CommentsSurface, CommentsToggle } from "./ui/CommentsSurface"
export { fileNoun, threadViews, type ThreadView, type Viewer } from "./ui/threadViews"
