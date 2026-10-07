import { expect, test } from "bun:test"
import { buildFrame, mergeLicenses } from "./preview-frame.ts"

const app = "# Licenses\n\nThe app bundles dependencies which contain the following licenses:\n\n## react - 19.2.8 (MIT)\n\nMIT text\n"
const frame = "# Licenses\n\nIntro\n\n## react - 19.2.8 (MIT)\n\nMIT text\n\n## prosemirror-view - 1.42.3 (MIT)\n\nPM text\n"

test("the frame's packages are added once, after the app's", () => {
  const merged = mergeLicenses(app, frame)
  expect(merged.match(/^## react - /gm)).toHaveLength(1)
  expect(merged).toEndWith("## prosemirror-view - 1.42.3 (MIT)\n\nPM text\n")
  expect(mergeLicenses(merged, frame)).toBe(merged)
})

test("a different version of a package the app has is listed too", () => {
  const merged = mergeLicenses(app, "## react - 19.3.0 (MIT)\n\nnewer\n")
  expect(merged.match(/^## react - /gm)).toHaveLength(2)
})

// The dev server builds the frame inside a process whose NODE_ENV is
// "development"; the frame must still be the production build, or its JSX
// calls jsxDEV, which the production React runtime it bundles does not have.
test("the frame is a production build inside a development process too", async () => {
  const before = process.env.NODE_ENV
  process.env.NODE_ENV = "development"
  try {
    const { code } = await buildFrame("charts")
    expect(code).not.toContain("jsxDEV")
    expect(code).not.toContain("jsx-dev-runtime")
    expect(code).toContain('require("react/jsx-runtime")')
  } finally {
    process.env.NODE_ENV = before
  }
}, 120_000)
