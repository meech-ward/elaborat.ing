import { expect, test } from "bun:test"
import { readOnlyReason } from "./readOnly"

test("an archived project, or one the person may only view, says why it cannot be changed", () => {
  expect(readOnlyReason({ archived: false, role: "owner" })).toBeNull()
  expect(readOnlyReason({ archived: false, role: "editor" })).toBeNull()
  expect(readOnlyReason({ archived: false, role: "viewer" })).toBe("You can view this project but not change it.")
  expect(readOnlyReason({ archived: false, role: "commenter" })).toBe("You can read and comment on this project.")
  expect(readOnlyReason({ archived: true, role: "owner" })).toBe("This project is archived. Unarchive it to make changes.")
  expect(readOnlyReason({ archived: true, role: "editor" })).toBe("This project is archived. Unarchive it to make changes.")
  expect(readOnlyReason({ archived: true, role: "viewer" })).toBe("This project is archived, so it cannot be changed.")
  // Before the project's details are known, nothing is held back.
  expect(readOnlyReason(undefined)).toBeNull()
})
