import { createLucideIcon } from "lucide-react"

/**
 * The design's diamond: a square turned on its corner with sharp points
 * (Lucide's Diamond rounds them). Made with Lucide's own factory, so it takes
 * the same props and stroke as every other icon. It is the app's mark in the
 * project header and the Diamond tool on the canvas.
 */
export const SharpDiamond = createLucideIcon("SharpDiamond", [["path", { d: "M12 2 22 12 12 22 2 12Z", key: "sharp-diamond" }]])
