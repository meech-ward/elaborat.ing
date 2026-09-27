// Public entry point for the design system: the product components built on
// the shadcn primitives in src/components/ui (they live in ./ui), and the
// style guide page that shows every one of them in the active palette.
//
// Each component group adds its exports inside its own block below, so
// groups built at the same time do not touch the same lines.

export { StyleGuidePage } from "./guide/StyleGuidePage"

// --- Controls (guide/ControlsSection.tsx) ---
export { ActionContextMenu, ActionMenu, type MenuEntry } from "./ui/ActionMenu"
export { Banner, BannerAction, Callout, type BannerTone } from "./ui/Banner"
export { ButtonShortcut } from "./ui/ButtonShortcut"
export { EmptyState } from "./ui/EmptyState"
export { Hint } from "./ui/Hint"
export { LoadingLine } from "./ui/LoadingLine"
export { DirtyDot, StatusDot, type SaveStatus } from "./ui/StatusDot"
// --- end Controls ---

// --- Navigation (guide/NavigationSection.tsx) ---
export { IconRow, PersonRow, initialFor } from "./ui/AccountRows"
export { FloatingPanel, floatingPanelVariants, type FloatingPanelProps } from "./ui/FloatingPanel"
export { KindBadge, kindBadgeVariants, type FileKind } from "./ui/KindBadge"
export { PanelRow, panelRowVariants, type PanelRowProps, type PanelRowSize } from "./ui/PanelRow"
export { ProjectHeader } from "./ui/ProjectHeader"
export { SearchField, type SearchFieldProps } from "./ui/SearchField"
export { TreeFileRow, TreeFolderRow, TreeRowMenu } from "./ui/TreeRows"
// --- end Navigation ---

// --- Editor chrome (guide/EditorChromeSection.tsx) ---
// --- end Editor chrome ---

// --- Canvas (guide/CanvasSection.tsx) ---
// --- end Canvas ---
