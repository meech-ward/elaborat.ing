import { Outlet, createRootRoute } from "@tanstack/react-router"
import { UpdateReady } from "@/features/updates"

export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <UpdateReady />
    </>
  ),
})
