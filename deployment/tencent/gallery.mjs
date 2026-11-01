import { getGalleryPhotos as sharedGallery, photoColumns } from '../../db/gallery.ts';
import { getCurrentAccount } from './database.mjs';

export { photoColumns };
export async function getGalleryPhotos() {
  const photos = await sharedGallery();
  const account = getCurrentAccount();
  return photos.map(photo => {
    if (photo.isSample) return photo;
    const src = `/api/media/${account ? account.public_id+'/' : ''}${encodeURIComponent(photo.id)}`;
    return { ...photo, photographer: account ? account.display_name : photo.photographer,
      src: account ? src : photo.src, thumbnailSrc: photo.imageKey ? src+'?preview=1' : photo.src };
  });
}
