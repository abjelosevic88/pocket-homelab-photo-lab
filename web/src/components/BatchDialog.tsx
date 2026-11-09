// Edit together: one look, size and format for many pictures, saved as a
// ZIP, to Pocket Photos or Pocket Files, or kept as their edit in the lab.
import { useMemo, useState } from 'react'
import { api, V1 } from '../lib/api'
import type { Image, Preset } from '../lib/types'
import { applyLook, clean, isEdited, LOOKS, type Recipe } from '../lib/recipe'
import { encode, EXT, loadBitmap, MAX_AREA, render } from '../lib/render/engine'
import { downloadBlob, fileName, originalURL, saveLook, sendExport } from '../lib/images'
import { makeZip } from '../lib/zip'
import { useApp } from '../lib/app-context'
import { Icon } from './icons'
import { Select } from './Select'
import { SaveFields, useSaveDefaults } from './ExportDialog'
import { Field, Modal, SettingRow, Spinner, Switch, useAsync, useToast, errMsg } from './ui'

export function BatchDialog({ images, onClose, onDone, initialLook = '' }: { images: Image[]; onClose: () => void; onDone: () => void; initialLook?: string }) {
  const { settings } = useApp()
  const { toast } = useToast()
  const { data: presets } = useAsync(() => api.get<Preset[]>(`${V1}/presets`), [])
  const [keep, setKeep] = useState(true)
  const [look, setLook] = useState(initialLook)
  const [strength, setStrength] = useState(100)
  const [mode, setMode] = useState<'save' | 'lab'>('save')
  const [o, setO] = useSaveDefaults()
  const [pattern, setPattern] = useState(settings?.export_name || '{title}-edited')
  const [progress, setProgress] = useState<{ done: number; failed: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const lookOptions = useMemo(() => [{ value: '', label: 'No look' }, ...(presets || []).map(p => ({ value: `p${p.id}`, label: p.name, group: 'Your looks' })), ...LOOKS.map(l => ({ value: `b${l.name}`, label: l.label, group: 'Built in' }))], [presets])
  const recipeFor = (im: Image): Recipe => {
    let r: Recipe = keep ? { ...im.recipe } : {}
    if (look.startsWith('p')) { const p = presets?.find(x => `p${x.id}` === look); if (p) r = applyLook(r, p.recipe) }
    else if (look.startsWith('b')) r = { ...r, look: { name: look.slice(1), strength } }
    return clean(r)
  }
  const run = async () => {
    setBusy(true); setProgress({ done: 0, failed: [] })
    const zip: { name: string; blob: Blob }[] = []
    const failed: string[] = []
    for (let i = 0; i < images.length; i++) {
      const im = images[i]
      try {
        const bmp = await loadBitmap(originalURL(im))
        const r = recipeFor(im)
        if (mode === 'lab') {
          await api.put(`${V1}/images/${im.id}`, { recipe: r, edited: isEdited(r) })
          const prev = await render(bmp, bmp.width, bmp.height, r, { maxEdge: 2048 })
          await saveLook(im.id, await encode(prev, 'jpeg', 0.88))
        } else {
          const c = await render(bmp, bmp.width, bmp.height, r, { maxEdge: o.edge || undefined, maxArea: MAX_AREA, transparent: o.format !== 'jpeg' })
          const blob = await encode(c, o.format, o.quality, r.frame?.color || '#ffffff')
          const name = `${fileName(pattern, im, c.width, c.height, i + 1)}.${EXT[o.format]}`
          if (o.dest === 'download') zip.push({ name, blob })
          await sendExport({ image_id: im.id, destination: o.dest, name, format: o.format, width: c.width, height: c.height, bytes: blob.size, folder: o.folder }, o.dest === 'download' ? undefined : blob)
        }
        bmp.close()
      } catch (e) { failed.push(`${im.title}: ${errMsg(e)}`) }
      setProgress({ done: i + 1, failed: [...failed] })
    }
    if (mode === 'save' && o.dest === 'download' && zip.length) {
      if (zip.length === 1) downloadBlob(zip[0].blob, zip[0].name)
      else downloadBlob(await makeZip(zip), `Photo Lab ${new Date().toISOString().slice(0, 10)}.zip`)
    }
    setBusy(false)
    const ok = images.length - failed.length
    toast(mode === 'lab' ? `${ok} ${ok === 1 ? 'picture' : 'pictures'} changed in the lab` : `${ok} ${ok === 1 ? 'picture' : 'pictures'} saved`, failed.length ? 'err' : 'ok')
    if (!failed.length) onDone()
  }
  const pct = progress ? Math.round((progress.done / images.length) * 100) : 0
  return (
    <Modal title={`Edit ${images.length} ${images.length === 1 ? 'picture' : 'pictures'} together`} onClose={busy ? () => {} : onClose} size="lg"
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Close</button><button type="button" className="btn primary" onClick={run} disabled={busy || !images.length}>{busy ? <><Spinner />Working… {progress?.done}/{images.length}</> : mode === 'lab' ? 'Change them in the lab' : o.dest === 'download' ? (images.length > 1 ? 'Download as ZIP' : 'Download') : 'Save copies'}</button></>}>
      <div className="batch">
        <div className="batch-strip">{images.slice(0, 14).map(im => <img key={im.id} src={`${V1}/images/${im.id}/thumb?v=${encodeURIComponent(im.updated_at)}`} alt="" />)}{images.length > 14 && <span className="muted small">+{images.length - 14}</span>}</div>
        <div className="grid" style={{ gap: 14 }}>
          <SettingRow title="Keep their own edits" help="Crops, text and light you already set stay; off = start from the originals."><Switch checked={keep} onChange={setKeep} label="Keep edits" /></SettingRow>
          <div className="two-col tight">
            <Field group label="Look"><Select ariaLabel="Look" value={look} onChange={setLook} options={lookOptions} /></Field>
            {look.startsWith('b') && <Field label={`Strength: ${strength}%`}><input type="range" min={0} max={100} value={strength} onChange={e => setStrength(Number(e.target.value))} /></Field>}
          </div>
          <Field group label="Then">
            <div className="segmented">
              <button type="button" className={mode === 'save' ? 'active' : ''} onClick={() => setMode('save')}>Save copies</button>
              <button type="button" className={mode === 'lab' ? 'active' : ''} onClick={() => setMode('lab')}>Change them in the lab</button>
            </div>
          </Field>
          {mode === 'save' && <>
            <SaveFields o={o} setO={setO} />
            <Field label="Names" help="{title} the picture's name, {n} its number, {date} today, {w}×{h} its size."><input value={pattern} onChange={e => setPattern(e.target.value)} /></Field>
          </>}
          {mode === 'lab' && <p className="muted small">The look becomes part of each picture's edit (you can still change or undo it there). Nothing is downloaded.</p>}
          {progress && <div><span className="progress lg"><span style={{ width: `${pct}%` }} /></span><p className="muted small">{progress.done} of {images.length} done</p>
            {progress.failed.length > 0 && <div className="callout danger"><Icon name="alert" size={15} /><div>{progress.failed.map(f => <div key={f}>{f}</div>)}</div></div>}</div>}
        </div>
      </div>
    </Modal>
  )
}
