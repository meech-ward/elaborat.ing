import type { Frame, Page, TestInfo } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"

/** Timings contain only milestones and durations, never URLs, source or tokens. */
export async function recordReadiness(page: Page | Frame, testInfo: TestInfo, milestone: string) {
  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
    const paint = performance.getEntriesByName("first-contentful-paint")[0]
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[]
    const data = resources.filter(entry => entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest")
    // Cross-origin services can omit Timing-Allow-Origin. Their aggregate
    // duration remains useful, but hidden responseStart must not become a
    // fabricated transfer duration measured from navigation start.
    const timed = data.filter(entry => entry.responseStart > 0)
    return {
      usefulContentMs: performance.now(),
      shellPaintMs: paint?.startTime ?? null,
      htmlHeadersMs: navigation?.responseStart ?? null,
      htmlTransferMs: navigation ? navigation.responseEnd - navigation.responseStart : null,
      completedDataRequests: data.length,
      opaqueDataRequests: data.length - timed.length,
      aggregateDataDurationMs: data.reduce((total, entry) => total + entry.duration, 0),
      dataWaitMs: timed.length ? timed.reduce((total, entry) => total + entry.responseStart - entry.startTime, 0) : null,
      dataTransferMs: timed.length ? timed.reduce((total, entry) => total + entry.responseEnd - entry.responseStart, 0) : null,
      completedScriptRequests: resources.filter(entry => entry.initiatorType === "script").length,
    }
  })
  await mkdir(testInfo.outputDir, {recursive: true})
  const path = testInfo.outputPath(`${milestone}.json`)
  await writeFile(path, JSON.stringify({ milestone, ...timing }, null, 2))
  await testInfo.attach(`${milestone}.json`, {path, contentType: "application/json"})
  return timing
}
