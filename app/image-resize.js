'use client';

/**
 * Shrinks a photograph in the browser before it is uploaded.
 *
 * A phone camera produces a 12-megapixel JPEG of two to five megabytes. A
 * storefront shows it at a few hundred pixels wide. Sending the original costs a
 * student's data on the way up, the store's customers' data on the way down,
 * and — before next.config.mjs raised it — ran straight into the 1 MB Server
 * Action limit, which is why store photos never appeared.
 *
 * So the longest edge is capped at `maxEdge` and the result is re-encoded as a
 * JPEG. Anything that cannot be decoded here (an unusual format, a browser
 * without canvas support) is returned UNCHANGED rather than refused: the server
 * still checks the type and the size, and is the only check that counts.
 */
export async function resizeImage(file, { maxEdge = 1600, quality = 0.85 } = {}) {
  if (!file || !file.type?.startsWith('image/')) return file;

  try {
    const bitmap = await decode(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));

    // Already small and already a JPEG: re-encoding would only lose quality.
    if (scale === 1 && file.type === 'image/jpeg' && file.size < 1024 * 1024) {
      bitmap.close?.();
      return file;
    }

    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;

    const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/** createImageBitmap honours EXIF orientation; an <img> fallback covers older Safari. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file, { imageOrientation: 'from-image' });
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
