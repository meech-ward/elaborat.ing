/**
 * The side panels, built from the design system: the project panel (the
 * project menu and share), the files panel (search, New file, New folder and
 * the tree) and the account panel (connected agents, Look and theme, and the
 * person with the sync status). The desktop shows them floating down the
 * side; a phone shows the same panels, flat and larger, as its files screen.
 */
import { Link } from "@tanstack/react-router";
import { Bot, FolderPlus, Lock, Plus, Sun } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { SidebarMenu } from "@/components/ui/sidebar";
import {
  ActionMenu,
  FloatingPanel,
  IconRow,
  PanelMessage,
  PersonRow,
  ProjectHeader,
  StatusDot,
  type ActionMenuProps,
  type MenuEntry,
  type PanelRowSize,
  type SaveStatus,
} from "@/features/design-system";
import { cn } from "@/lib/utils";

/**
 * The project's name as a menu (the other projects, the way home and the
 * project's actions) and the share button, with anything the project needs
 * to say under it (read-only, errors). A local project's share button asks
 * to sign up. The name is also the page's heading, for screen readers.
 */
export function ProjectPanel({
  ref,
  size,
  name,
  menu,
  menuProps,
  onShare,
  local = false,
  notices,
  children,
}: {
  ref?: Ref<HTMLElement>;
  size: PanelRowSize;
  name: string;
  menu: readonly MenuEntry[];
  menuProps?: ActionMenuProps;
  onShare?: () => void;
  local?: boolean;
  notices?: ReactNode;
  /** Hidden inputs that belong to the menu's actions. */
  children?: ReactNode;
}) {
  const touch = size === "touch";
  return (
    <header ref={ref} className={cn("flex shrink-0 flex-col gap-2", !touch && "mb-1")}>
      <h1 className="sr-only">{name}</h1>
      <ProjectHeader
        name={name}
        menuLabel={`${name}, project menu`}
        menu={menu}
        menuProps={menuProps}
        onShare={local ? undefined : onShare}
        shareLink={local ? <Link to="/sign-up" /> : undefined}
        shareLabel={local ? "Sign up to share" : "Share project"}
        size={touch ? "touch" : "default"}
        variant={touch ? "flat" : "floating"}
      >
        {children}
      </ProjectHeader>
      {notices}
    </header>
  );
}

/**
 * The files panel, a navigation landmark: `children` are the search field,
 * the New buttons and the tree (FileSearch puts the results in the tree's place).
 */
export function FilesPanel({ size, children }: { size: PanelRowSize; children: ReactNode }) {
  const touch = size === "touch";
  return (
    <FloatingPanel
      variant={touch ? "flat" : "floating"}
      render={<nav aria-label="Workspace files" />}
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", touch ? "min-h-60 p-2.5" : "px-2 py-2.5")}
    >
      {children}
    </FloatingPanel>
  );
}

/** Where the tree scrolls, under the search field and the New buttons. */
export function TreeScroller({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

/**
 * New file (a menu: note, drawing or diagram) and New folder, side by side.
 * On a phone they are the 40 high text buttons.
 */
export function NewButtons({
  size,
  newFile,
  menuProps,
  onNewFolder,
}: {
  size: PanelRowSize;
  newFile: readonly MenuEntry[];
  menuProps?: ActionMenuProps;
  onNewFolder: () => void;
}) {
  const touch = size === "touch";
  return (
    <div className={cn("grid grid-cols-2", touch ? "mb-2 gap-2" : "mx-0.5 mb-2 gap-1.5")}>
      <ActionMenu
        {...menuProps}
        entries={newFile}
        contentProps={{ align: "start", ...menuProps?.contentProps }}
        trigger={
          <Button size={touch ? "touch" : "sm"} className={cn(!touch && "rounded-tool")}>
            {!touch && <Plus aria-hidden="true" strokeWidth={2.4} />}
            New file
          </Button>
        }
      />
      <Button variant="secondary" size={touch ? "touch" : "sm"} className={cn(!touch && "rounded-tool")} onClick={onNewFolder}>
        {!touch && <FolderPlus aria-hidden="true" />}
        New folder
      </Button>
    </div>
  );
}

/** The sync state: the dot, the words it shows, and the whole sentence for screen readers. */
export interface PanelSync {
  status: SaveStatus;
  text: string;
  label: string;
}

/** The person, as the account panel shows them. */
export interface PanelPerson {
  name: string;
  email: string;
  image?: string;
}

/**
 * The account panel. Signed in: Connected agents with how many (on phones it
 * is in the person's menu), Look and theme, and the person with the sync
 * status and a menu (Settings, Sync now, Sign out). A local project instead
 * says where its work is kept, with the ways to sign up.
 */
export function AccountPanel({
  size,
  local = false,
  agentCount,
  onLookAndTheme,
  person,
  menu,
  menuProps,
  sync,
}: {
  size: PanelRowSize;
  local?: boolean;
  agentCount?: number;
  onLookAndTheme: () => void;
  person: PanelPerson | null;
  menu: readonly MenuEntry[];
  menuProps?: ActionMenuProps;
  sync?: PanelSync | null;
}) {
  const touch = size === "touch";
  // On a desktop the status sits on the person's first line and announces
  // changes; while all is synced only screen readers have it, as C5 draws the
  // person with no status. On a phone it takes the gear's place inside the
  // person's button, where a live region is not heard, so a hidden one says
  // it instead.
  const status = sync ? (
    touch ? (
      <StatusDot status={sync.status} size="touch">
        {sync.text}
      </StatusDot>
    ) : (
      <StatusDot role="status" status={sync.status} title={sync.label} className={cn(sync.status === "synced" && "sr-only")}>
        <span aria-hidden="true">{sync.text}</span>
        <span className="sr-only">{sync.label}</span>
      </StatusDot>
    )
  ) : null;
  return (
    <FloatingPanel
      variant={touch ? "flat" : "floating"}
      render={<section aria-label="Account and app" />}
      className={cn("flex shrink-0 flex-col", touch ? "px-2 pt-1.5 pb-2" : "p-2")}
    >
      <SidebarMenu>
        {local ? (
          <IconRow size={size} icon={<Lock aria-hidden="true" />} label="Sign up to connect agents" render={<Link to="/sign-up" />} />
        ) : (
          !touch && <IconRow icon={<Bot aria-hidden="true" />} label="Connected agents" count={agentCount || undefined} render={<Link to="/agents" />} />
        )}
        <IconRow size={size} icon={<Sun aria-hidden="true" />} label="Look and theme" onClick={onLookAndTheme} />
      </SidebarMenu>
      {local ? (
        <LocalNote size={size} />
      ) : person ? (
        <PersonRow
          size={size}
          name={person.name}
          email={person.email}
          image={person.image}
          menu={menu}
          menuLabel="Account and settings"
          menuProps={menuProps}
          status={touch ? undefined : status}
          trailing={touch ? status ?? undefined : undefined}
        />
      ) : null}
      {touch && sync && (
        <p role="status" className="sr-only">
          {sync.label}
        </p>
      )}
    </FloatingPanel>
  );
}

/** A local project's note: kept in this browser only, and signing up keeps it. */
function LocalNote({ size }: { size: PanelRowSize }) {
  const touch = size === "touch";
  return (
    <div className={cn("flex flex-col gap-2", touch ? "px-2.5 pt-2" : "px-2 pt-2 pb-0.5")}>
      <PanelMessage size={size}>
        <span role="status" className="font-semibold text-foreground">
          Saved in this browser only.
        </span>{" "}
        It is lost if the browser clears this site's data.
      </PanelMessage>
      <Link to="/sign-up" className={cn(buttonVariants({ size: touch ? "touch" : "sm" }), !touch && "rounded-tool")}>
        Sign up to create projects
      </Link>
    </div>
  );
}
