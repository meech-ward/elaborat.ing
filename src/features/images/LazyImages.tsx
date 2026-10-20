import type { ComponentProps } from 'react'
import { moduleLoader, useModule } from '@/lib/moduleLoader'
import { Banner, BannerAction, LoadingLine } from '@/features/design-system'
import type { ImagePicker } from './ImagePicker'
import type { ImageView } from './ImageView'

const picker = moduleLoader(() => import('./ImagePicker'))
const viewer = moduleLoader(() => import('./ImageView'))
export function LazyImagePicker(props: ComponentProps<typeof ImagePicker>) {
  const loaded = useModule(picker, props.open)
  if (!props.open) return null
  if (loaded.module) return <loaded.module.ImagePicker {...props} />
  return loaded.error ? <Banner tone="danger" action={<BannerAction onClick={loaded.retry}>Try again</BannerAction>}>The image picker could not load.</Banner> : <LoadingLine label="Loading images" />
}
export function LazyImageView(props: ComponentProps<typeof ImageView>) {
  const loaded = useModule(viewer, true)
  if (loaded.module) return <loaded.module.ImageView {...props} />
  return loaded.error ? <Banner tone="danger" action={<BannerAction onClick={loaded.retry}>Try again</BannerAction>}>The image could not load.</Banner> : <LoadingLine label="Loading image" />
}
