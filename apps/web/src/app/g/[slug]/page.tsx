import { Placeholder } from '@/components/placeholder';

export const metadata = { title: 'Gallery' };

// TODO(T16): load `PublicGalleryResponse` for the slug (public gallery endpoint + media tokens),
// parse it with `publicGalleryResponseSchema` and render `<GalleryView gallery items />` from
// `@/components/gallery`. The UI is developed against `/dev/gallery?n=2000` until then.
export default function Page() {
  return <Placeholder title="Gallery" task="T16" />;
}
