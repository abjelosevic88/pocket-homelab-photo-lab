// HEIC/HEIF pictures (iPhone photos) for browsers that can't open them:
// libheif (LGPL-3.0, its own file, loaded only when a HEIC needs it).

interface HeifImage { get_width(): number; get_height(): number; display(d: { data: Uint8ClampedArray; width: number; height: number }, cb: (d: { data: Uint8ClampedArray } | null) => void): void }
interface Libheif { HeifDecoder: new () => { decode(b: Uint8Array): HeifImage[] } }

let lib: Promise<Libheif> | null = null

export const isHeic = (b: Uint8Array) => b.length > 12 && String.fromCharCode(...b.subarray(4, 8)) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(String.fromCharCode(...b.subarray(8, 12)))

export async function decodeHeic(blob: Blob): Promise<ImageBitmap> {
  lib ||= import('libheif-js/libheif-wasm/libheif-bundle.mjs').then(async m => {
    const f = (m as { default: unknown }).default
    return (typeof f === 'function' ? await (f as () => Libheif | Promise<Libheif>)() : f) as Libheif
  })
  const heif = await lib
  const images = new heif.HeifDecoder().decode(new Uint8Array(await blob.arrayBuffer()))
  const im = images[0]
  if (!im) throw new Error('this HEIC file has no picture in it')
  const width = im.get_width(), height = im.get_height()
  const data = await new Promise<Uint8ClampedArray>((resolve, reject) => im.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, d => d ? resolve(d.data) : reject(new Error('the HEIC picture could not be read'))))
  return createImageBitmap(new ImageData(new Uint8ClampedArray(data), width, height))
}
