import { z } from 'zod/mini'

// MCP Apps frames have no 'unsafe-eval', so Zod must not compile parsers with
// new Function. Zod decides when each schema is made, so this module is
// imported before any module that makes one.
z.config({ jitless: true })
