// Writes a small EXIF block into a JPEG: the date taken and, if wanted, the
// camera. Browsers drop all metadata when they make a picture; this puts back
// only what the person chose. Never the location.

function tiff(entries0: [number, number, Uint8Array | number][], exif: [number, number, Uint8Array | number][]): Uint8Array {
  // little-endian TIFF: header, IFD0, Exif IFD, then the values that don't fit in 4 bytes
  const ifdSize = (n: number) => 2 + n * 12 + 4
  const exifPtr = exif.length > 0
  const ifd0 = exifPtr ? [...entries0, [0x8769, 4, 0] as [number, number, number]] : entries0
  ifd0.sort((a, b) => a[0] - b[0]); exif.sort((a, b) => a[0] - b[0])
  const off0 = 8, offExif = off0 + ifdSize(ifd0.length)
  let dataOff = offExif + (exifPtr ? ifdSize(exif.length) : 0)
  const blobs: { off: number; bytes: Uint8Array }[] = []
  const buf = new Uint8Array(4096)
  const dv = new DataView(buf.buffer)
  dv.setUint16(0, 0x4949, true); dv.setUint16(2, 42, true); dv.setUint32(4, off0, true)
  const write = (at: number, list: [number, number, Uint8Array | number][], next: number) => {
    dv.setUint16(at, list.length, true)
    list.forEach(([tag, type, v], i) => {
      const e = at + 2 + i * 12
      dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true)
      if (tag === 0x8769) { dv.setUint32(e + 4, 1, true); dv.setUint32(e + 8, offExif, true); return }
      if (typeof v === 'number') { dv.setUint32(e + 4, 1, true); if (type === 3) dv.setUint16(e + 8, v, true); else dv.setUint32(e + 8, v, true); return }
      dv.setUint32(e + 4, v.length, true)
      if (v.length <= 4) buf.set(v, e + 8)
      else { dv.setUint32(e + 8, dataOff, true); blobs.push({ off: dataOff, bytes: v }); dataOff += v.length + (v.length % 2) }
    })
    dv.setUint32(at + 2 + list.length * 12, next, true)
  }
  write(off0, ifd0, 0)
  if (exifPtr) write(offExif, exif, 0)
  for (const b of blobs) buf.set(b.bytes, b.off)
  return buf.slice(0, dataOff)
}

const ascii = (s: string) => { const b = new TextEncoder().encode(s.replace(/[^\x20-\x7e]/g, '?')); const out = new Uint8Array(b.length + 1); out.set(b); return out }

/** "2024-06-01T18:30:00" → "2024:06:01 18:30:00" */
function exifDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso || '')
  return m ? `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}` : null
}

export async function withExif(blob: Blob, o: { taken?: string; camera?: string }): Promise<Blob> {
  if (blob.type !== 'image/jpeg') return blob
  const date = o.taken ? exifDate(o.taken) : null
  const ifd0: [number, number, Uint8Array | number][] = [[0x0112, 3, 1], [0x0131, 2, ascii('Pocket Photo Lab')]]
  if (o.camera) {
    const parts = o.camera.trim().split(/\s+/)
    if (parts.length > 1) ifd0.push([0x010F, 2, ascii(parts[0])])
    ifd0.push([0x0110, 2, ascii(o.camera.trim())])
  }
  const exif: [number, number, Uint8Array | number][] = []
  if (date) { ifd0.push([0x0132, 2, ascii(date)]); exif.push([0x9003, 2, ascii(date)], [0x9004, 2, ascii(date)]) }
  if (!date && !o.camera) return blob
  const t = tiff(ifd0, exif)
  const app1 = new Uint8Array(4 + 6 + t.length)
  app1[0] = 0xff; app1[1] = 0xe1
  new DataView(app1.buffer).setUint16(2, 2 + 6 + t.length)
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4)
  app1.set(t, 10)
  const src = new Uint8Array(await blob.arrayBuffer())
  if (src[0] !== 0xff || src[1] !== 0xd8) return blob
  return new Blob([src.subarray(0, 2), app1, src.subarray(2)], { type: 'image/jpeg' })
}
