// Talking to the server about pictures: addresses, uploads, saving results.
import { api, ApiError, V1 } from './api'
import type { Image, ImportResult, Export, SaveTo } from './types'
import { decodeBlob } from './render/engine'

export const thumbURL = (im: Pick<Image, 'id' | 'updated_at'>) => `${V1}/images/${im.id}/thumb?v=${encodeURIComponent(im.updated_at)}`
export const originalURL = (im: Pick<Image, 'id' | 'sha256'>) => `${V1}/images/${im.id}/original?v=${im.sha256.slice(0, 12) || '1'}`
export const previewURL = (im: Pick<Image, 'id' | 'updated_at'>) => `${V1}/images/${im.id}/preview?v=${encodeURIComponent(im.updated_at)}`

async function postForm<T>(url: string, fd: FormData, method = 'POST'): Promise<T> {
  const res = await fetch(url, { method, body: fd, credentials: 'same-origin' })
  const j = await res.json().catch(() => ({}))
  if (res.status === 401) window.dispatchEvent(new CustomEvent('plab:unauthorized'))
  if (!res.ok) throw new ApiError(res.status, j.error || res.statusText, j)
  return j as T
}

/** Kinds every browser opens; others get a thumbnail made here before upload. */
const SERVER_READS = /^image\/(jpeg|png|gif|webp|bmp|tiff)$/

async function browserThumb(file: File): Promise<string | null> {
  try {
    const bmp = await decodeBlob(file)
    const k = Math.min(1, 512 / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k))
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close()
    return c.toDataURL('image/jpeg', 0.82)
  } catch { return null }
}

/** Uploads one picture. */
export async function uploadOne(file: File, extra: Record<string, string> = {}): Promise<ImportResult> {
  const fd = new FormData()
  fd.append('file', file, file.name || 'picture')
  if (!SERVER_READS.test(file.type)) { const t = await browserThumb(file); if (t) fd.append('thumb', t) }
  for (const [k, v] of Object.entries(extra)) fd.append(k, v)
  return postForm<ImportResult>(`${V1}/images`, fd)
}

/** Uploads several pictures, three at a time; progress(done, total). */
export async function uploadMany(files: File[], progress?: (done: number, total: number) => void): Promise<ImportResult> {
  const out: ImportResult = { items: [], already: [], skipped: [] }
  let next = 0, done = 0
  const work = async () => {
    while (next < files.length) {
      const f = files[next++]
      try { const r = await uploadOne(f); out.items.push(...r.items); out.already.push(...r.already); out.skipped.push(...r.skipped) } catch (e) { out.skipped.push({ name: f.name, error: (e as Error).message }) }
      progress?.(++done, files.length)
    }
  }
  await Promise.all([work(), work(), work()])
  return out
}

/** "3 pictures added, 1 already here, 1 skipped: …" */
export function importSummary(r: ImportResult): string {
  const parts: string[] = []
  if (r.items.length) parts.push(`${r.items.length} ${r.items.length === 1 ? 'picture' : 'pictures'} added`)
  if (r.already.length) parts.push(`${r.already.length} already in the lab`)
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped: ${r.skipped[0].error}`)
  return parts.join(', ') || 'Nothing added'
}

export async function saveLook(id: number, blob: Blob): Promise<void> {
  const res = await fetch(`${V1}/images/${id}/look`, { method: 'PUT', body: blob, credentials: 'same-origin', headers: { 'Content-Type': blob.type || 'image/jpeg' } })
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new ApiError(res.status, j.error || res.statusText, j) }
}

/** Records a finished picture and, for Photos and Files, takes it there. */
export async function sendExport(meta: { image_id?: number; destination: SaveTo; name: string; format: string; width: number; height: number; bytes: number; folder?: string; space?: string; conversation?: number; text?: string; title?: string }, blob?: Blob): Promise<{ export: Export; open_url?: string; stacked?: boolean; stack_error?: string }> {
  if (meta.destination === 'download' || !blob) return api.post(`${V1}/exports`, meta)
  const fd = new FormData()
  fd.append('meta', JSON.stringify(meta))
  fd.append('file', blob, meta.name)
  return postForm(`${V1}/exports`, fd)
}

/** Saves a blob as a download. */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** A file name from the pattern: {title} {date} {n} {w} {h}. */
export function fileName(pattern: string, im: { title: string }, w: number, h: number, n = 1): string {
  const d = new Date()
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const name = (pattern || '{title}-edited').replace(/\{title\}/g, im.title || 'picture').replace(/\{date\}/g, date).replace(/\{n\}/g, String(n)).replace(/\{w\}/g, String(w)).replace(/\{h\}/g, String(h))
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120) || 'picture'
}

export const SOURCE_NAME: Record<string, string> = { upload: 'Uploaded', photos: 'Pocket Photos', files: 'Pocket Files', copy: 'A copy', collage: 'Collage' }
export const sourceName = (s: string) => SOURCE_NAME[s] || (s ? `Pocket ${s[0].toUpperCase()}${s.slice(1)}` : '')
