export type BeforeSignOut = () => Promise<void | (() => void)>;

export async function withSignOutGuards(handlers: Iterable<BeforeSignOut>, signOut: () => Promise<void>): Promise<void> {
  const releases: Array<() => void> = [];
  try {
    for (const handler of handlers) { const release = await handler(); if (release) releases.push(release); }
    await signOut();
  } finally { for (const release of releases) release(); }
}
