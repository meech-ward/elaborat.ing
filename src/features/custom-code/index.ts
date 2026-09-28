// Public entry point for custom code in shared projects: a note that runs
// components from the project's files, its own exports, or expressions in
// its text that run code waits behind a notice until the person chooses to
// run that exact code (useCustomCodeGate.ts, CustomCodeNotice.tsx); the
// choice is remembered on this device per file version (approvals.ts).
// ProjectPage provides the policy for projects the person does not own
// (context.tsx).

export { approveCode, approvedCode, codeFiles, waitingFiles, type CodeFile } from "./approvals"
export { CustomCodeProvider, useCustomCodePolicy, type CustomCodePolicy } from "./context"
export { CustomCodeNotice } from "./CustomCodeNotice"
export { useCustomCodeGate, type CustomCodeGate } from "./useCustomCodeGate"
