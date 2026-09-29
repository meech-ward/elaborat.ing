import { expect, test } from "bun:test"
import { ownedProjectsDeleted } from "./deletionWording"

test("the sentence about owned projects says who else loses them only for the shared ones", () => {
  expect(ownedProjectsDeleted(1, 0)).toBe("The project you own is deleted.")
  expect(ownedProjectsDeleted(1, 1)).toBe("The project you own is deleted, for everyone it is shared with.")
  expect(ownedProjectsDeleted(3, 0)).toBe("The 3 projects you own are deleted.")
  expect(ownedProjectsDeleted(3, 3)).toBe("The 3 projects you own are deleted, for everyone they are shared with.")
  expect(ownedProjectsDeleted(2, 1)).toBe("The 2 projects you own are deleted, the shared one for everyone it is shared with.")
  expect(ownedProjectsDeleted(4, 2)).toBe("The 4 projects you own are deleted, the 2 shared ones for everyone they are shared with.")
})
