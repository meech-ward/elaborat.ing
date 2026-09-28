import { expect, test } from "bun:test"
import { useState } from "react"
import { frameModules, receiveFrameModule, setFrameModuleRequest } from "./frameModules"

const asked: string[] = []
let canAsk = true
setFrameModuleRequest((name) => {
  if (canAsk) asked.push(name)
  return canAsk
})

test("a module runs from the code the parent sends, with the frame's own React and class-name helper", async () => {
  const loading = frameModules.charts.load()
  expect(asked).toEqual(["charts"])
  receiveFrameModule({
    name: "charts",
    code: 'const React = require("react"); exports.DOCUMENT_CHART_COMPONENTS = { useState: React.useState, classes: require("@/lib/utils").cn("p-1", "p-2") }',
  })
  const module = (await loading) as unknown as { DOCUMENT_CHART_COMPONENTS: { useState: unknown; classes: string } }
  expect(module.DOCUMENT_CHART_COMPONENTS.useState).toBe(useState)
  expect(module.DOCUMENT_CHART_COMPONENTS.classes).toBe("p-2")
  expect(frameModules.charts.loaded()).toBe(module as never)
  // Loaded once: using it again asks nothing more.
  await frameModules.charts.load()
  expect(asked).toEqual(["charts"])
})

test("a module that cannot load says why, and the next use asks again", async () => {
  asked.length = 0
  const failed = frameModules.highlighter.load()
  receiveFrameModule({ name: "highlighter", error: "Offline." })
  await expect(failed).rejects.toThrow("Offline.")

  const needsMore = frameModules.highlighter.load()
  receiveFrameModule({ name: "highlighter", code: 'require("node:fs")' })
  await expect(needsMore).rejects.toThrow("needs node:fs")
  expect(asked).toEqual(["highlighter", "highlighter"])
  expect(frameModules.highlighter.loaded()).toBeNull()
})

test("before the frame can ask, loading fails instead of waiting forever, and an answer nobody asked for is ignored", async () => {
  canAsk = false
  await expect(frameModules.highlighter.load()).rejects.toThrow("not ready")
  receiveFrameModule({ name: "highlighter", code: "exports.highlightCode = () => null" })
  expect(frameModules.highlighter.loaded()).toBeNull()
  canAsk = true
})
