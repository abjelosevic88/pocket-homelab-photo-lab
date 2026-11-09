// Looks: the built-in ones on a picture of yours, and the looks you saved.
import { useEffect, useState } from 'react'
import { api, V1 } from '../lib/api'
import type { Image, Preset } from '../lib/types'
import { applyLook, describe, LOOKS, type Recipe } from '../lib/recipe'
import { drawGeometry, cropSize, makeCanvas, loadBitmap } from '../lib/render/engine'
import { process } from '../lib/render/pixels'
import { previewURL } from '../lib/images'
import { Icon } from '../components/icons'
import { Select } from '../components/Select'
import { BatchDialog } from '../components/BatchDialog'
import { LabPicker } from '../components/Pickers'
import { announceChange, useOnChange } from '../components/Layout'
import { Confirm, Empty, Loading, MenuButton, Modal, useAsync, useToast, errMsg } from '../components/ui'

export default function Looks() {
  const { toast } = useToast()
  const { data: presets, reload } = useAsync(() => api.get<Preset[]>(`${V1}/presets`), [])
  const { data: lib } = useAsync(() => api.get<{ items: Image[] }>(`${V1}/images?limit=60`), [])
  useOnChange(reload)
  const [sample, setSample] = useState<number | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [use, setUse] = useState<{ look: string; label: string } | null>(null)
  const [batch, setBatch] = useState<{ images: Image[]; look: string } | null>(null)
  const [rename, setRename] = useState<Preset | null>(null)
  const [del, setDel] = useState<Preset | null>(null)
  const pic = lib?.items.find(i => i.id === sample) || lib?.items[0]
  useEffect(() => {
    if (!pic) return
    let alive = true
    loadBitmap(previewURL(pic)).then(bmp => {
      if (!alive) return
      const none: Recipe = {}
      const base = drawGeometry(bmp, bmp.width, bmp.height, none, Math.min(1, 360 / Math.max(...cropSize(none, bmp.width, bmp.height))))
      bmp.close()
      const px0 = base.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, base.width, base.height)
      const make = (r: Recipe) => {
        const d = new ImageData(new Uint8ClampedArray(px0.data), base.width, base.height)
        process(d.data, base.width, base.height, r)
        const c = makeCanvas(base.width, base.height); c.getContext('2d')!.putImageData(d, 0, 0)
        return c.toDataURL('image/jpeg', 0.85)
      }
      const out: Record<string, string> = { '': make({}) }
      for (const l of LOOKS) out[`b${l.name}`] = make({ look: { name: l.name, strength: 100 } })
      for (const p of presets || []) out[`p${p.id}`] = make(applyLook({}, p.recipe))
      if (alive) setThumbs(out)
    }).catch(() => {})
    return () => { alive = false }
  }, [pic?.id, pic?.updated_at, presets]) // eslint-disable-line react-hooks/exhaustive-deps
  const doRename = async (p: Preset, name: string) => { try { await api.put(`${V1}/presets/${p.id}`, { name }); reload(); toast('Renamed') } catch (e) { toast(errMsg(e), 'err') } }
  const doDelete = async (p: Preset) => { try { await api.del(`${V1}/presets/${p.id}`); reload(); announceChange(); toast(`“${p.name}” deleted`) } catch (e) { toast(errMsg(e), 'err') } }
  return (
    <div className="stack loose">
      <div className="lib-head">
        <div className="grow"><h2 className="page-title">Looks</h2><p className="muted small">Ready-made edits to start from, and your own. In the editor they mix in at the strength you choose.</p></div>
        {lib && lib.items.length > 0 && <div className="looks-sample"><Select ariaLabel="Show the looks on" value={String(pic?.id || '')} onChange={v => setSample(Number(v))} options={lib.items.map(i => ({ value: String(i.id), label: i.title }))} /></div>}
      </div>
      {!lib ? <Loading /> : !lib.items.length ? <Empty title="No pictures yet" icon="image">Add a picture to see the looks on it.</Empty> : <>
        <section>
          <h3 className="group-h">Your looks</h3>
          {presets && presets.length === 0 && <p className="muted small">In the editor, Looks → Save this look keeps the light, colour and effects you set, to put on any picture.</p>}
          <div className="looks-page-grid">
            {presets?.map(p => (
              <div key={p.id} className="look-card">
                {thumbs[`p${p.id}`] ? <img src={thumbs[`p${p.id}`]} alt="" /> : <span className="look-ph" />}
                <div className="look-card-meta">
                  <div className="grow" style={{ minWidth: 0 }}><div className="ellipsis"><b>{p.name}</b></div><div className="muted small ellipsis">{describe(p.recipe).join(', ') || 'no changes'}</div></div>
                  <MenuButton label="More" className="btn ghost icon-only sm" align="right" items={[
                    { label: 'Put on pictures…', icon: 'wand', onSelect: () => setUse({ look: `p${p.id}`, label: p.name }) },
                    { label: 'Rename', icon: 'edit', onSelect: () => setRename(p) },
                    'sep', { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDel(p) },
                  ]}><Icon name="more" size={15} /></MenuButton>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section>
          <h3 className="group-h">Built in</h3>
          <div className="looks-page-grid">
            {LOOKS.map(l => (
              <button type="button" key={l.name} className="look-card" onClick={() => setUse({ look: `b${l.name}`, label: l.label })} title={`Put ${l.label} on pictures`}>
                {thumbs[`b${l.name}`] ? <img src={thumbs[`b${l.name}`]} alt="" /> : <span className="look-ph" />}
                <div className="look-card-meta"><b>{l.label}</b></div>
              </button>
            ))}
          </div>
        </section>
      </>}
      {use && <LabPicker title={`Put “${use.label}” on…`} max={200} onClose={() => setUse(null)} onDone={ims => { setBatch({ images: ims, look: use.look }); setUse(null) }} />}
      {batch && <BatchDialog images={batch.images} initialLook={batch.look} onClose={() => setBatch(null)} onDone={() => { setBatch(null); announceChange() }} />}
      {rename && <RenameModal preset={rename} onClose={() => setRename(null)} onSave={n => { const p = rename; setRename(null); doRename(p, n) }} />}
      {del && <Confirm title={`Delete “${del.name}”?`} message="Pictures it was put on keep their edit." confirmLabel="Delete" onCancel={() => setDel(null)} onConfirm={() => { const p = del; setDel(null); doDelete(p) }} />}
    </div>
  )
}

function RenameModal({ preset, onClose, onSave }: { preset: Preset; onClose: () => void; onSave: (n: string) => void }) {
  const [name, setName] = useState(preset.name)
  return (
    <Modal title="Rename the look" size="sm" onClose={onClose}>
      <form onSubmit={e => { e.preventDefault(); if (name.trim()) onSave(name.trim()) }} className="grid" style={{ gap: 14 }}>
        <input value={name} onChange={e => setName(e.target.value)} autoFocus maxLength={80} />
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()}>Save</button></div>
      </form>
    </Modal>
  )
}
