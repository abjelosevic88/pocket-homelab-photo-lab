// Saving a finished picture: format, quality, size, name and where it goes
// (a download, a new photo in Pocket Photos, a file in Pocket Files).
import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../lib/app-context'
import type { Format, Image, SaveTo } from '../lib/types'
import type { Recipe } from '../lib/recipe'
import { canAVIF, encode, EXT, finalSize, imageSize, MAX_AREA, render } from '../lib/render/engine'
import { downloadBlob, fileName, sendExport } from '../lib/images'
import { withExif } from '../lib/exif'
import { fmtBytes } from '../lib/format'
import { Icon } from './icons'
import { Select } from './Select'
import { useSources } from './Layout'
import { Field, Modal, Segmented, Spinner, useAsync, useToast, errMsg } from './ui'
import { api, V1 } from '../lib/api'

export const EDGES = [0, 4096, 3840, 2560, 2048, 1920, 1600, 1280, 1080, 800, 512]
export const edgeLabel = (e: number, w?: number, h?: number) => e === 0 ? `Full size${w && h ? ` (${w}×${h})` : ''}` : `${e} px on the long side${e === 1080 ? ' (social)' : e === 1920 ? ' (HD)' : e === 3840 ? ' (4K)' : e === 1280 ? ' (email)' : ''}`

export interface SaveOpts { format: Format; quality: number; edge: number; dest: SaveTo; folder: string; conversation?: number; text?: string; title?: string }

export function useSaveDefaults(): [SaveOpts, (o: SaveOpts) => void] {
  const { settings } = useApp()
  const [o, setO] = useState<SaveOpts>({ format: settings?.export_format || 'jpeg', quality: settings?.export_quality || 0.92, edge: settings?.export_max_edge || 0, dest: settings?.save_to || 'download', folder: settings?.files_folder || '/Photo Lab' })
  return [o, setO]
}

/** Format, quality, size and destination controls (shared with batch). */
const DESTS: { value: SaveTo; label: string; hint?: string; app?: 'photos' | 'files' | 'blog' | 'chat' | 'notes' | 'documents'; basic?: boolean }[] = [
  { value: 'download', label: 'This device', basic: true },
  { value: 'photos', label: 'Pocket Photos', hint: 'a new photo', app: 'photos', basic: true },
  { value: 'files', label: 'Pocket Files', hint: 'a folder', app: 'files', basic: true },
  { value: 'blog', label: 'Pocket Blog', hint: 'a draft post', app: 'blog' },
  { value: 'chat', label: 'Pocket Chat', hint: 'a message', app: 'chat' },
  { value: 'notes', label: 'Pocket Notes', hint: 'a new note', app: 'notes' },
  { value: 'documents', label: 'Pocket Documents', hint: 'the archive', app: 'documents' },
]

function ChatFields({ o, setO }: { o: SaveOpts; setO: (o: SaveOpts) => void }) {
  const { data, error } = useAsync(() => api.get<{ id: number; name: string }[]>(`${V1}/sources/chat/conversations`), [])
  useEffect(() => { if (data?.length && !o.conversation) setO({ ...o, conversation: data[0].id }) }, [data]) // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <Field group label="Conversation">{error ? <p className="bad small">{error}</p> : <Select ariaLabel="Conversation" value={String(o.conversation || '')} onChange={v => setO({ ...o, conversation: Number(v) })} options={(data || []).map(c => ({ value: String(c.id), label: c.name }))} placeholder="Loading…" />}</Field>
    <Field label="Message (optional)"><textarea rows={2} value={o.text || ''} onChange={e => setO({ ...o, text: e.target.value })} /></Field>
  </>
}

/** destinations: true = all, 'basic' = device, Photos, Files (batch), false = none */
export function SaveFields({ o, setO, w, h, destinations = true }: { o: SaveOpts; setO: (o: SaveOpts) => void; w?: number; h?: number; destinations?: boolean | 'basic' }) {
  const sources = useSources()
  const [avif, setAvif] = useState(false)
  useEffect(() => { canAVIF().then(setAvif) }, [])
  const lossy = o.format !== 'png'
  return (
    <div className="grid" style={{ gap: 14 }}>
      <Field group label="Format" help={o.format === 'jpeg' ? 'Best for photos; no see-through parts.' : o.format === 'png' ? 'Exact pixels and see-through parts; larger files.' : o.format === 'webp' ? 'Smaller than JPEG, keeps see-through parts; most apps open it.' : 'The smallest files; newer apps only.'}>
        <Segmented value={o.format} onChange={v => setO({ ...o, format: v })} options={[{ value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }, { value: 'avif', label: 'AVIF', disabled: !avif, title: avif ? undefined : 'This browser cannot make AVIF' }]} />
      </Field>
      {lossy && <Field label={`Quality: ${Math.round(o.quality * 100)}%`} help="90% looks the same as 100% at about half the size.">
        <input type="range" min={30} max={100} value={Math.round(o.quality * 100)} onChange={e => setO({ ...o, quality: Number(e.target.value) / 100 })} />
      </Field>}
      <Field group label="Size">
        <Select ariaLabel="Size" value={String(o.edge)} onChange={v => setO({ ...o, edge: Number(v) })} options={EDGES.filter(e => !w || !h || e === 0 || e < Math.max(w, h)).map(e => ({ value: String(e), label: edgeLabel(e, w, h) }))} />
      </Field>
      {destinations && <Field group label="Save to">
        <Select ariaLabel="Save to" value={o.dest} onChange={v => setO({ ...o, dest: v as SaveTo })} options={DESTS.filter(d => destinations === true || d.basic).map(d => {
          const st = d.app ? sources?.[d.app] : undefined
          return { value: d.value, label: d.label, hint: st && !st.ready ? 'not connected' : d.hint, disabled: !!st && !st.ready }
        })} />
      </Field>}
      {destinations && o.dest === 'files' && <Field label="Folder in My files"><input value={o.folder} onChange={e => setO({ ...o, folder: e.target.value })} placeholder="/Photo Lab" /></Field>}
      {destinations === true && o.dest === 'chat' && <ChatFields o={o} setO={setO} />}
      {destinations === true && (o.dest === 'blog' || o.dest === 'notes' || o.dest === 'documents') && <>
        <Field label={o.dest === 'blog' ? 'Post title' : o.dest === 'notes' ? 'Note title' : 'Document title'}><input value={o.title || ''} onChange={e => setO({ ...o, title: e.target.value })} /></Field>
        {o.dest !== 'documents' && <Field label={o.dest === 'blog' ? 'A few words under the picture (optional)' : 'Text (optional)'}><textarea rows={2} value={o.text || ''} onChange={e => setO({ ...o, text: e.target.value })} /></Field>}
      </>}
    </div>
  )
}

export function ExportDialog({ image, recipe, src, onClose, onSaved }: { image: Image; recipe: Recipe; src: ImageBitmap; onClose: () => void; onSaved: () => void }) {
  const { settings } = useApp()
  const { toast } = useToast()
  const [o, setO] = useSaveDefaults()
  const [w, h] = useMemo(() => finalSize(recipe, src.width, src.height), [recipe, src])
  const [iw, ih] = imageSize(recipe, src.width, src.height)
  const out = useMemo(() => { const k = o.edge && Math.max(iw, ih) > o.edge ? o.edge / Math.max(iw, ih) : 1; return [Math.round(w * k), Math.round(h * k)] }, [o.edge, w, h, iw, ih])
  const [name, setName] = useState(() => fileName(settings?.export_name || '{title}-edited', image, w, h))
  const [busy, setBusy] = useState('')
  const [done, setDone] = useState<{ bytes: number; url?: string } | null>(null)
  const save = async () => {
    setBusy('Making the picture…')
    try {
      const canvas = await render(src, src.width, src.height, recipe, { maxEdge: o.edge || undefined, maxArea: MAX_AREA, transparent: o.format !== 'jpeg' })
      const blob = await withExif(await encode(canvas, o.format, o.quality, recipe.frame?.color || '#ffffff'), { taken: settings?.keep_date !== false ? image.taken_at : '', camera: settings?.keep_camera ? image.camera : '' })
      const file = `${name || 'picture'}.${EXT[o.format]}`
      setBusy(o.dest === 'download' ? 'Saving…' : `Sending to ${DESTS.find(d => d.value === o.dest)?.label}…`)
      if (o.dest === 'download') downloadBlob(blob, file)
      const r = await sendExport({ image_id: image.id, destination: o.dest, name: file, format: o.format, width: canvas.width, height: canvas.height, bytes: blob.size, folder: o.folder, conversation: o.conversation, text: o.text, title: o.title || image.title }, o.dest === 'download' ? undefined : blob)
      setDone({ bytes: blob.size, url: r.open_url })
      toast(o.dest === 'download' ? `Saved ${file}` : o.dest === 'photos' ? (r.stacked ? 'Added to Pocket Photos, stacked on the original' : 'Added to Pocket Photos as a new photo') : o.dest === 'files' ? `Saved to Pocket Files: ${r.export.target}` : o.dest === 'chat' ? 'Sent to Pocket Chat' : o.dest === 'blog' ? 'A draft post is waiting in Pocket Blog' : o.dest === 'notes' ? 'Kept in a new note' : 'Filed in Pocket Documents')
      onSaved()
    } catch (e) { toast(errMsg(e), 'err') } finally { setBusy('') }
  }
  return (
    <Modal title="Save a copy" onClose={onClose} size="sm"
      footer={<><button type="button" className="btn" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button><button type="button" className="btn primary" onClick={save} disabled={!!busy}>{busy ? <><Spinner />{busy}</> : <><Icon name="download" size={15} />Save</>}</button></>}>
      <div className="grid" style={{ gap: 14 }}>
        <Field label="Name"><div className="input-suffix"><input value={name} onChange={e => setName(e.target.value)} /><span className="muted">.{EXT[o.format]}</span></div></Field>
        <SaveFields o={o} setO={setO} w={w} h={h} />
        <p className="muted small">{out[0]}×{out[1]} pixels. {o.format === 'jpeg' && settings?.keep_date !== false && image.taken_at ? `The date taken goes with it${settings?.keep_camera && image.camera ? ', and the camera' : ''}; never the location. ` : 'No location or camera details go with it. '}The lab keeps your edit, so you can come back and change it.</p>
        {done && <div className="callout ok"><Icon name="check-circle" size={15} /><span>Saved ({fmtBytes(done.bytes)}).{done.url && <> <a href={done.url} target="_blank" rel="noreferrer">Open {DESTS.find(d => d.value === o.dest)?.label}</a></>}</span></div>}
      </div>
    </Modal>
  )
}
