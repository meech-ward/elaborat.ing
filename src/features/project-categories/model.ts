import { z } from "zod/mini"

export const MAX_CATEGORY_NAME_LENGTH = 160
export const MAX_PROJECT_CATEGORIES = 1000
export const MAX_PROJECTS_PER_CATEGORY = 10_000

const validCharacters = (name: string) => Array.from(name).length <= MAX_CATEGORY_NAME_LENGTH &&
  name.normalize("NFC") === name && !/[\u0000-\u001f\u007f-\u009f]/.test(name)

export const CategoryName = z.string().check(
  z.minLength(1), z.maxLength(MAX_CATEGORY_NAME_LENGTH * 2),
  z.refine(name => validCharacters(name) && name.trim() === name && /\S/.test(name)),
)

// Postgres char_length counts Unicode code points, whereas browser maxlength
// counts UTF-16 units. Stored btrim removes ASCII spaces, not all JS whitespace.
// Read valid server names even when an ordinary input would normalize them.
const StoredCategoryName = z.string().check(
  z.minLength(1), z.maxLength(MAX_CATEGORY_NAME_LENGTH * 2),
  z.refine(name => validCharacters(name) && name.replace(/^ +| +$/g, "") === name),
)

const timestamp = z.string().check(z.maxLength(64), z.refine(value => Number.isFinite(Date.parse(value))))
const fields = {
  id: z.uuid(),
  name: StoredCategoryName,
  archived_at: z.nullable(timestamp),
  updated_at: timestamp,
  revision: z.int().check(z.nonnegative()),
  project_ids: z.array(z.uuid()).check(z.maxLength(MAX_PROJECTS_PER_CATEGORY), z.refine(ids => new Set(ids).size === ids.length)),
}

/** A category and only the project ids the signed-in user may currently read. */
export const ProjectCategory = z.object(fields)
export type ProjectCategory = z.infer<typeof ProjectCategory>
export const ProjectCategories = z.array(ProjectCategory).check(z.maxLength(MAX_PROJECT_CATEGORIES))

/** Cached browser records use the exact known shape and never carry tokens. */
export const CachedProjectCategories = z.array(z.strictObject(fields)).check(z.maxLength(MAX_PROJECT_CATEGORIES))

export function categoryName(input: string): string {
  const name = input.trim().normalize("NFC")
  if (!CategoryName.safeParse(name).success) throw new Error(`Use a category name between 1 and ${MAX_CATEGORY_NAME_LENGTH} characters.`)
  return name
}
