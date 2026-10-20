import { expect, test } from "bun:test"
import { validateImageTransform } from "./transform"

test("image crops and output sizes are bounded before canvas allocation", () => {
  const source = { width: 1200, height: 800 }
  const valid = { x: 100, y: 50, cropWidth: 1000, cropHeight: 700, width: 500, height: 350 }
  expect(() => validateImageTransform(source, valid)).not.toThrow()
  for (const bad of [
    { x: -1 }, { y: 801 }, { cropWidth: 1200 }, { cropHeight: 800 },
    { width: 0 }, { height: 0 }, { width: 0.5 }, { width: Infinity },
    { width: 5001, height: 5000 }, { width: 32_768, height: 1 },
  ]) expect(() => validateImageTransform(source, { ...valid, ...bad })).toThrow()
})
