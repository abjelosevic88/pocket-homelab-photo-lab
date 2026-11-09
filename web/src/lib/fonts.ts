// Fonts of one's own (Settings → fonts, or Text → Add a font): loaded into the page once.
import { api, V1 } from './api'

export interface Font { id: number; name: string; mime: string; bytes: number; created_at: string }

const loaded = new Set<number>()
let list: Font[] = []

/** Loads every font of the person's; answers the list. */
export async function loadFonts(): Promise<Font[]> {
  try { list = await api.get<Font[]>(`${V1}/fonts`) } catch { return list }
  await Promise.all(list.filter(f => !loaded.has(f.id)).map(async f => {
    try {
      const face = new FontFace(`plab-font-${f.id}`, `url(${V1}/fonts/${f.id}/file)`)
      await face.load()
      document.fonts.add(face)
      loaded.add(f.id)
    } catch { /* a broken font file */ }
  }))
  return list
}

export async function uploadFont(file: File): Promise<Font> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('name', file.name.replace(/\.(ttf|otf|woff2?)$/i, ''))
  const res = await fetch(`${V1}/fonts`, { method: 'POST', body: fd, credentials: 'same-origin' })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || res.statusText)
  await loadFonts()
  return j as Font
}
