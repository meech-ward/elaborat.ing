import type { ReactNode } from "react";
import { MoreHorizontal, Save } from "lucide-react";
import {
  ActionMenu,
  PhoneHeader,
  RoundIconButton,
  SaveButton,
  ViewSwitch,
  type EditorView,
  type MenuEntry,
  type ViewNames,
} from "@/features/design-system";
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
 * over the file: Back at the top left; the view switch, "..." with the
 * actions and Save at the top right. The switch stays one tap away there,
 * as a compact two-view switch, because Source and Rendered (Code and
 * Canvas) are what a phone edits with. Save shows only while there is
 * something to save.
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
  const viewSwitch = (floating: boolean) =>
    view && (
      <ViewSwitch
        aria-label={view.label}
        floating={floating}
        views={view.views}
        names={view.names}
        value={view.value}
        onValueChange={view.onChange}
      />
    );
  if (desktop)
    return (
      <TablineActions active={active}>
        {viewSwitch(false)}
        {save && <SaveButton disabled={save.disabled} onClick={save.onSave} />}
      </TablineActions>
    );
  if (!navigation) return null;
  return (
    <PhoneHeader back={navigation}>
      {viewSwitch(true)}
      <ActionMenu
        entries={actions}
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
