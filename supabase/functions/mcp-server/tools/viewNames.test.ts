import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { Client } from 'npm:@modelcontextprotocol/client@2.0.0'
import { InMemoryTransport, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'

import { FILE_VIEW_URI } from './fileView.ts'
import { registerTools, type ToolContext } from './index.ts'
import { PANEL_VIEW_URI } from './panel.ts'

// A host keeps the tool list it last read and asks for the view names on it
// until it refreshes, so a view's earlier names must keep answering after a
// rename. One that stops answering shows the person "App unavailable".

/** Every name a view had before `uri`: the same name at each lower version. */
function earlierNames(uri: string): string[] {
  const match = /^(.*-v)(\d+)(\.html)$/.exec(uri)
  if (!match) throw new Error(`no version in ${uri}`)
  const [, head, version, tail] = match
  return Array.from({ length: Number(version) - 1 }, (_, index) => `${head}${index + 1}${tail}`)
}

Deno.test('every earlier name of the file view and the panel view still answers', async () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  registerTools(server, { supabase: {}, userClaims: { id: 'someone' } } as unknown as ToolContext)
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    for (const current of [FILE_VIEW_URI, PANEL_VIEW_URI]) {
      const earlier = earlierNames(current)
      assertEquals(earlier.length > 0, true, `${current} has no earlier names to check`)
      for (const uri of earlier) {
        const { contents } = await client.readResource({ uri })
        assertEquals(contents[0]?.uri, uri)
      }
    }
  } finally {
    await client.close()
    await server.close()
  }
})
