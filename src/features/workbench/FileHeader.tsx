import type { ReactNode } from "react";
import { MoreHorizontal, Save } from "lucide-react";
import {
  ActionMenu,
  PhoneHeader,
  RoundIconButton,
  SaveButton,
  ViewSwitch,
  isApplePlatform,
  viewLabel,
  viewShortcut,
  EDITOR_VIEWS,
  type EditorView,
  type MenuChoice,
  type MenuEntry,
  type ViewNames,
} from "@/features/design-system";
import { CommentsToggle } from "@/features/comments";
import { TablineActions, useDesktopFrame, useFileActions } from "./tabline";

export type FileHeaderView = {
  value: EditorView;
  views: readonly EditorView[];
  /** A note's view names (Source, Split, Rendered) or a canvas's (Code, Split, Canvas). */
  names: ViewNames;
  /** The switch's accessible name, such as "Drawing view". */
  label: string;
  onChange: (view: EditorView) => void;
};

/**
 * One open file's header, the same for notes, drawings and diagrams. On a
 * desktop its view switch and Save go to the editor's top line while it is
 * the active file, and its actions to its tab's menu. On a phone they float
 * over the file, as C5 draws them: Back at the top left; the comments, "..."
 * and Save at the top right, with the views (Source and Rendered, or Code
 * and Canvas) as a choice at the top of "..." above the actions. Save shows
 * only while there is something to save.
 */
export function FileHeader({
  path,
  active,
  navigation,
  view,
  save,
  actions,
}: {
  path: string;
  active: boolean;
  /** The phone's Back button, while this is the active file on a phone. */
  navigation?: ReactNode;
  view?: FileHeaderView;
  /** Save, while there are unsaved edits (null otherwise). */
  save: { disabled: boolean; onSave: () => void } | null;
  actions: readonly MenuEntry[];
}) {
  useFileActions(path, actions);
  const desktop = useDesktopFrame();
  if (desktop)
    return (
      <TablineActions active={active}>
        {view && (
          <ViewSwitch aria-label={view.label} views={view.views} names={view.names} value={view.value} onValueChange={view.onChange} />
        )}
        {save && <SaveButton disabled={save.disabled} onClick={save.onSave} />}
      </TablineActions>
    );
  if (!navigation) return null;
  const apple = isApplePlatform();
  const choice: MenuChoice | undefined = view && {
    label: "View",
    value: view.value,
    options: EDITOR_VIEWS.filter((entry) => view.views.includes(entry.value)).map((entry) => ({
      value: entry.value,
      label: viewLabel(entry.value, view.names),
      keyShortcuts: viewShortcut(entry.digit, apple).aria,
    })),
    onValueChange: (next) => view.onChange(next as EditorView),
  };
  return (
    <PhoneHeader back={navigation}>
      <CommentsToggle size="touch" />
      <ActionMenu
        entries={actions}
        choice={choice}
        contentProps={{ align: "end", "aria-label": "File actions" }}
        trigger={
          <RoundIconButton label="File actions">
            <MoreHorizontal />
          </RoundIconButton>
        }
      />
      {save && (
        <RoundIconButton label="Save" dirty disabled={save.disabled} onClick={save.onSave}>
          <Save />
        </RoundIconButton>
      )}
    </PhoneHeader>
  );
}
