import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.4.3'

import { jsonResult } from './result.ts'
import type { ToolContext } from './types.ts'

// Answers from verified claims, demonstrating that every tool runs as the
// signed-in user.
//
// Local change to the block's tool: it is also the account's profile, so a
// chat with more than one account connected can tell them apart. The profile
// is exactly { id, name?, email?, nickname? } (id is the account's own id,
// which never changes); the block's role and OAuth client id are left out,
// since the model needs neither.
// https://developers.openai.com/plugins/build/auth

const profileSchema = z.strictObject({
  id: z.string().describe("The account's id."),
  name: z.string().optional().describe('The name the person uses in elaborat.ing, when they set one.'),
  email: z.string().optional().describe("The account's email address."),
  nickname: z.string().optional(),
})

export type Profile = z.infer<typeof profileSchema>

/**
 * The name the account shows under in the app: the one set in Settings, else
 * the one a sign-in provider gave, with spaces collapsed and cut to 80
 * characters, as the database's private.person_name does (without its
 * fallback to the email, which the profile has on its own).
 */
export function profileName(metadata: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['display_name', 'full_name', 'name']) {
    const value = metadata?.[key]
    if (typeof value !== 'string') continue
    const name = value.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (name) return name
  }
  return undefined
}

export function registerWhoamiTool(server: McpServer, { userClaims }: ToolContext): void {
  server.registerTool(
    'whoami',
    {
      title: 'Connected account',
      description: 'Use this to see which elaborat.ing account is connected: its id, and its name and email when it has them.',
      inputSchema: z.object({}),
      outputSchema: profileSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      // ChatGPT reads this tool to name each connected account.
      _meta: { 'openai/profile': true },
    },
    () => {
      const profile: Profile = { id: userClaims.id }
      const name = profileName(userClaims.userMetadata)
      if (name) profile.name = name
      if (userClaims.email) profile.email = userClaims.email
      return jsonResult(profile)
    }
  )
}
