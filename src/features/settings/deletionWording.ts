/**
 * Delete account's sentence about the projects the person owns: `owned` of
 * them (at least one), of which `shared` have someone else on them.
 */
export function ownedProjectsDeleted(owned: number, shared: number): string {
  const deleted = owned === 1 ? "The project you own is deleted" : `The ${owned} projects you own are deleted`
  const forEveryone = (count: number) => `for everyone ${count === 1 ? "it is" : "they are"} shared with.`
  if (shared === 0) return `${deleted}.`
  if (shared === owned) return `${deleted}, ${forEveryone(owned)}`
  return `${deleted}, the ${shared === 1 ? "shared one" : `${shared} shared ones`} ${forEveryone(shared)}`
}
