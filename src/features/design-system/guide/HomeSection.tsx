import { Ellipsis, Settings } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { AccountPill } from "../ui/AccountPill"
import { ActionMenu, type MenuEntry } from "../ui/ActionMenu"
import { AppBar } from "../ui/AppBar"
import { IconButton } from "../ui/IconButton"
import { NewProjectCard, ProjectCard, ProjectGrid } from "../ui/ProjectCard"
import { ScreenPreview } from "../ui/ScreenPreview"
import { StatusDot } from "../ui/StatusDot"
import { GuideGroup, GuideLabel, GuideValue } from "./parts"

// The pages outside a project: the top bar signed out and signed in, the
// home page's project cards, and the picture of the app the signed-out home
// shows.

const noop = () => {}

const accountMenu: MenuEntry[] = [
  { label: "Settings", onSelect: noop },
  { label: "Connected agents", onSelect: noop },
  { label: "Sign out", group: "account", onSelect: noop },
]

const projectMenu: MenuEntry[] = [
  { label: "Members", onSelect: noop },
  { label: "Archive", onSelect: noop },
  { label: "Delete permanently", onSelect: noop, destructive: true },
]

function CardActions({ title }: { title: string }) {
  return (
    <ActionMenu
      entries={projectMenu}
      contentProps={{ align: "end" }}
      trigger={
        <Button variant="ghost" size="icon" aria-label={`Actions for ${title}, sample`}>
          <Ellipsis aria-hidden="true" />
        </Button>
      }
    />
  )
}

function TopBars() {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GuideLabel>Top bar, signed out</GuideLabel>
      <AppBar
        home={<a href="#top-bar-sample" />}
        className="rounded-[4px] bg-(--bg) px-0 sm:px-0"
        actions={
          <>
            <IconButton label="Settings">
              <Settings />
            </IconButton>
            <Button variant="ghost">Sign in</Button>
            <Button className="max-sm:hidden">Start writing</Button>
          </>
        }
      />
      <GuideLabel>Top bar, signed in</GuideLabel>
      <AppBar
        home={<a href="#top-bar-sample" />}
        className="rounded-[4px] bg-(--bg) px-0 sm:px-0"
        actions={<AccountPill email="person@example.com" menu={accountMenu} />}
      />
      <GuideValue>
        The brand on a 44 high panel, the actions on their own, radius 12, 16 from the page edges. Signed in, the avatar and email open Settings,
        Connected agents and Sign out. Phones leave Start writing to the page.
      </GuideValue>
    </div>
  )
}

function Cards() {
  const [title, setTitle] = useState("")
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GuideLabel>Project cards</GuideLabel>
      <ProjectGrid aria-label="Project card samples">
        <NewProjectCard id="guide-new-project" value={title} onValueChange={setTitle} onSubmit={(event) => event.preventDefault()} />
        <ProjectCard
          title="Product notes"
          link={<a href="#project-card-sample" />}
          meta={<StatusDot status="synced" />}
          actions={<CardActions title="Product notes" />}
        />
        <ProjectCard
          title="Research (hover)"
          link={<a href="#project-card-sample" />}
          meta={<StatusDot status="unsaved">Saved on this device, waiting to sync</StatusDot>}
          actions={<CardActions title="Research" />}
          className="bg-[color-mix(in_oklab,var(--seg)_45%,var(--panel))]"
        />
        <ProjectCard
          title="Shared with me"
          link={<a href="#project-card-sample" />}
          meta={<StatusDot status="offline">On the server</StatusDot>}
          actions={<CardActions title="Shared with me" />}
          className="outline-2 outline-offset-2 outline-ring outline-solid"
        />
      </ProjectGrid>
      <GuideValue>
        New project first: a dashed card with the title field and Create. A project card opens anywhere but its actions; hover takes a seg wash, focus rings the
        card (the third). The sync state sits under the title; the ellipsis opens the project's menu.
      </GuideValue>
    </div>
  )
}

export function HomeSection() {
  return (
    <GuideGroup title="Home and sign-in">
      <div className="grid grid-cols-1 gap-7 lg:grid-cols-2">
        <TopBars />
        <div className="flex min-w-0 flex-col gap-3">
          <GuideLabel>Picture of the app</GuideLabel>
          <ScreenPreview />
          <GuideValue>C5's note in Split, made of the library's components at 1440 by 900 and scaled to fit; inert and hidden from screen readers.</GuideValue>
        </div>
      </div>
      <Cards />
    </GuideGroup>
  )
}
