import { describe, expect, test } from "bun:test"
import { mayApproveOwnEdits, nextCodeActivity } from "./codeActivity"

const own = [{ path: "note.mdx", token: "changed-code", own: true }]
const imported = [{ path: "widget.mdx", token: "changed-code", own: false }]
const running = { identity: 1, key: "person:project", running: true, editing: true }

describe("custom code editing authority", () => {
  test("the person's own edits keep a running document approved while its next environment is checked", () => {
    const checking = nextCodeActivity(running, 1, "person:project", true, "checking")
    expect(checking.running).toBe(true)
    expect(mayApproveOwnEdits(checking, 1, "person:project", own)).toBe(true)
    expect(mayApproveOwnEdits(checking, 1, "person:project", imported)).toBe(false)
    expect(mayApproveOwnEdits(checking, 1, "person:project", [])).toBe(false)
  })

  test("an assistant replacement cannot inherit the previous document's editing authority", () => {
    expect(mayApproveOwnEdits(running, 2, "person:project", own)).toBe(false)
    const checking = nextCodeActivity(running, 2, "person:project", true, "checking")
    expect(checking.running).toBe(false)
    expect(mayApproveOwnEdits(checking, 2, "person:project", own)).toBe(false)
    const allowed = nextCodeActivity(checking, 2, "person:project", true, "running")
    expect(mayApproveOwnEdits(allowed, 2, "person:project", own)).toBe(true)
  })

  test("a changed account or a new consent request drops automatic approval", () => {
    const anotherAccount = nextCodeActivity(running, 1, "other-person:project", true, "checking")
    expect(anotherAccount.running).toBe(false)
    expect(mayApproveOwnEdits(anotherAccount, 1, "other-person:project", own)).toBe(false)
    const asking = nextCodeActivity(running, 1, "person:project", true, "asking")
    expect(asking.running).toBe(false)
    expect(mayApproveOwnEdits(asking, 1, "person:project", own)).toBe(false)
  })

  test("a clean remote reload cannot approve changed code as a person's own edit", () => {
    const clean = nextCodeActivity(running, 1, "person:project", false, "checking")
    expect(mayApproveOwnEdits(clean, 1, "person:project", own)).toBe(false)
  })
})
