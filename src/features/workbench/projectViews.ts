import { createProjectContext, parseProjectContext, type ProjectContext } from "./projectContext";
type View = ProjectContext["views"][string];
const key = (partition: string) => `elaborating.project-views.v1:${partition}`;
export function readProjectView(partition: string, path: string): View | null {
  try { const raw = localStorage.getItem(key(partition)); return raw ? parseProjectContext(JSON.parse(raw))?.views[path] ?? null : null; } catch { return null; }
}
export function writeProjectView(partition: string, path: string, view: View): void {
  try {
    const raw = localStorage.getItem(key(partition));
    const current = raw ? parseProjectContext(JSON.parse(raw)) : null;
    const paths = [...(current?.openPaths ?? []).filter((entry) => entry !== path), path].slice(-32);
    localStorage.setItem(key(partition), JSON.stringify(createProjectContext(paths, path, { ...current?.views, [path]: view })));
  } catch { /* View preferences do not claim content durability. */ }
}
