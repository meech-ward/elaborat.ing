import { test as base } from "@playwright/test"

export * from "@playwright/test"

// Playwright's test as every browser spec runs it: a test fails when the app
// shows an error the test did not expect, even one that is gone by the time
// the test ends. That is an uncaught exception in any page or frame, or an
// error on screen in any of them: an alert (a danger banner, a conflict, a
// form's or a dialog's error) or a save or sync status that failed (Not
// saved, Not synced). A test that shows an error on purpose says so, by its
// text:
//
//   test("a wrong code says so", async ({ page, appErrors }) => {
//     appErrors.expect("That code did not work")
//
// Console errors are not checked: failed requests log them, and offline and
// network-failure journeys make those on purpose.

/** An error the app showed: on screen, or thrown in a page and not caught. */
export type ShownError = { kind: "on screen" | "uncaught"; text: string; what?: string; stack?: string; where: string; at: number }

export type AppErrors = {
  /** This test shows this error on purpose: an error whose text includes `message`, or matches it, does not fail the test. */
  expect(message: string | RegExp): void
  /** The errors shown so far that the test has not said it expects. */
  unexpected(): ShownError[]
}

type Found = Pick<ShownError, "text" | "what" | "where">

const REPORT = "__appErrorShown"

export const test = base.extend<{ appErrors: AppErrors }>({
  appErrors: [
    async ({ context }, use) => {
      const started = Date.now()
      const shown: ShownError[] = []
      const expected: (string | RegExp)[] = []
      const at = () => (Date.now() - started) / 1000
      context.on("weberror", (webError) => {
        const error = webError.error()
        if (notTheApps(error)) return
        shown.push({ kind: "uncaught", text: `${error.name}: ${error.message}`, stack: error.stack, where: webError.page()?.url() ?? "a page", at: at() })
      })
      await context.exposeBinding(REPORT, (_source, found: Found) => void shown.push({ kind: "on screen", ...found, at: at() }))
      await context.addInitScript(watchForErrors, REPORT)

      const matches = (text: string) => expected.some((message) => (typeof message === "string" ? text.includes(message) : message.test(text)))
      const unexpected = () => shown.filter((error) => !matches(error.text))
      await use({ expect: (message) => void expected.push(message), unexpected })

      const errors = unexpected()
      if (errors.length > 0) throw new Error(summary(errors))
    },
    { auto: true },
  ],
})

/**
 * An uncaught error that says nothing about the app: Playwright's own script
 * that blocks service workers (playwright.config.ts) runs in every frame, and
 * in Chromium it throws in a sandboxed one, such as a note's preview.
 */
function notTheApps(error: Error) {
  const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line))
  return error.message.startsWith("Failed to read the 'serviceWorker' property") && frames.every((line) => /^\s+at <anonymous>:\d+:\d+$/.test(line))
}

/** Runs in every page and frame: reports each alert or failed status when it shows, and again when its text changes. */
function watchForErrors(report: string) {
  const reported = new WeakMap<Element, string>()
  const scan = () => {
    for (const element of document.querySelectorAll('[role="alert"], [data-status="failed"]')) {
      // Monaco's announcements for screen readers are not the app's errors.
      if (element.closest(".monaco-aria-container")) continue
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim()
      if (!text || reported.get(element) === text || !element.checkVisibility()) continue
      reported.set(element, text)
      const tone = element.getAttribute("data-tone")
      const dialog = element.closest('[role="dialog"], [role="alertdialog"], dialog')
      const label = dialog?.getAttribute("aria-label") ?? document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")?.textContent
      const what = [element.matches('[role="alert"]') ? 'role="alert"' : 'data-status="failed"', tone && `data-tone="${tone}"`, label && `in the dialog "${label.trim()}"`]
      const send = (window as unknown as Record<string, ((found: Found) => Promise<void>) | undefined>)[report]
      send?.({ text, what: what.filter(Boolean).join(" "), where: location.href }).catch(() => {})
    }
  }
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
}

function summary(errors: ShownError[]) {
  const indent = (text: string) => text.split("\n").slice(0, 8).map((line) => `     ${line}`).join("\n")
  const lines = errors.map((error, index) => {
    const what = error.kind === "uncaught" ? "Uncaught in the page" : `On screen (${error.what})`
    // The stack, which starts with the name and message, or the two without one.
    const text = error.stack?.startsWith(error.text) ? error.stack : [error.text, error.stack].filter(Boolean).join("\n")
    return `  ${index + 1}. ${what}, ${error.at.toFixed(1)}s into the test, at ${error.where}:\n${indent(text)}`
  })
  return [
    `The app showed ${errors.length === 1 ? "an error" : `${errors.length} errors`} this test did not expect:`,
    ...lines,
    `If the test shows it on purpose, say so in the test: appErrors.expect("<part of its text>").`,
  ].join("\n\n")
}
