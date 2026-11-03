import { createFileRoute } from '@tanstack/react-router'
import { PublicFilePage } from '@/features/file-sharing/PublicFilePage'

export const Route = createFileRoute('/s/$token')({component: SharedPage})
function SharedPage() {
  const {token} = Route.useParams()
  return <PublicFilePage key={token} token={token} />
}
