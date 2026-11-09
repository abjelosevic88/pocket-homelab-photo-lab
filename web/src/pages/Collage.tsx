// A collage: 2 to 9 pictures in a layout, with space between, rounded
// corners and a background; it becomes a new picture in the lab.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import type { Image, ImportResult } from '../lib/types'
import { SWATCHES } from '../lib/recipe'
import { encode, loadBitmap, makeCanvas } from '../lib/render/engine'
import { previewURL, uploadOne } from '../lib/images'
import { Icon } from '../components/icons'
import { Select } from '../components/Select'
import { LabPicker } from '../components/Pickers'
import { announceChange } from '../components/Layout'
import { Empty, Field, Spinner, useToast, errMsg } from '../components/ui'
import { Slider } from '../components/editor/Slider'

type Cell = [number, number, number, number]
interface Layout { id: string; label: string; cells: Cell[] }

function grid(n: number): Cell[] {
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols)
  const out: Cell[] = []
  for (let r = 0; r < rows; r++) {
    const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols
    for (let c = 0; c < inRow; c++) out.push([c / inRow, r / rows, 1 / inRow, 1 / rows])
  }
  return out
}
function layoutsFor(n: number): Layout[] {
  const L: Layout[] = [{ id: 'grid', label: 'Grid', cells: grid(n) }]
  const cols: Cell[] = Array.from({ length: n }, (_, i) => [i / n, 0, 1 / n, 1])
  const rows: Cell[] = Array.from({ length: n }, (_, i) => [0, i / n, 1, 1 / n])
  if (n <= 4) { L.push({ id: 'cols', label: 'Side by side', cells: cols }, { id: 'rows', label: 'Stacked', cells: rows }) }
  if (n >= 3) {
    const rest = n - 1
    L.push({ id: 'big-left', label: 'One big, left', cells: [[0, 0, 0.6, 1], ...Array.from({ length: rest }, (_, i) => [0.6, i / rest, 0.4, 1 / rest] as Cell)] })
    L.push({ id: 'big-top', label: 'One big, top', cells: [[0, 0, 1, 0.62], ...Array.from({ length: rest }, (_, i) => [i / rest, 0.62, 1 / rest, 0.38] as Cell)] })
  }
  if (n === 2) L.push({ id: 'big-left', label: 'Wide and narrow', cells: [[0, 0, 0.64, 1], [0.64, 0, 0.36, 1]] })
  if (n === 5) L.push({ id: '2-3', label: '2 over 3', cells: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 1 / 3, 0.5], [1 / 3, 0.5, 1 / 3, 0.5], [2 / 3, 0.5, 1 / 3, 0.5]] })
  return L
}
const ASPECT: Record<string, number> = { '1:1': 1, '4:5': 0.8, '3:2': 1.5, '2:3': 2 / 3, '16:9': 16 / 9, '9:16': 9 / 16 }

export default function Collage() {
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [images, setImages] = useState<Image[]>([])
  const [bmps, setBmps] = useState<Record<number, ImageBitmap>>({})
  const [picking, setPicking] = useState(false)
  const [layout, setLayout] = useState('grid')
  const [aspect, setAspect] = useState('1:1')
  const [gap, setGap] = useState(2)
  const [radius, setRadius] = useState(0)
  const [bg, setBg] = useState('#ffffff')
  const [edge, setEdge] = useState(2400)
  const [offsets, setOffsets] = useState<Record<number, [number, number]>>({})
  const [busy, setBusy] = useState(false)
  const view = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const ids = (sp.get('ids') || '').split(',').map(Number).filter(Boolean)
    if (!ids.length) return
    api.get<{ items: Image[] }>(`${V1}/images?limit=500`).then(r => setImages(ids.map(id => r.items.find(i => i.id === id)).filter(Boolean) as Image[])).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true
    for (const im of images) if (!bmps[im.id]) loadBitmap(previewURL(im)).then(b => { if (alive) setBmps(m => ({ ...m, [im.id]: b })) }).catch(() => {})
    return () => { alive = false }
  }, [images]) // eslint-disable-line react-hooks/exhaustive-deps
  const layouts = useMemo(() => layoutsFor(Math.max(1, images.length)), [images.length])
  const lay = layouts.find(l => l.id === layout) || layouts[0]

  const draw = (c: HTMLCanvasElement, long: number) => {
    const ar = ASPECT[aspect] || 1
    const W = ar >= 1 ? long : Math.round(long * ar), H = ar >= 1 ? Math.round(long / ar) : long
    c.width = W; c.height = H
    const g = c.getContext('2d')!
    g.fillStyle = bg; g.fillRect(0, 0, W, H)
    const sp = (gap / 100) * Math.min(W, H)
    lay.cells.forEach((cell, i) => {
      const im = images[i]; const b = im && bmps[im.id]
      const x = cell[0] * (W - sp) + sp, y = cell[1] * (H - sp) + sp, w = cell[2] * (W - sp) - sp, h = cell[3] * (H - sp) - sp
      g.save()
      g.beginPath(); g.roundRect(x, y, w, h, (radius / 100) * Math.min(w, h) / 2); g.clip()
      if (b) {
        const k = Math.max(w / b.width, h / b.height)
        const dw = b.width * k, dh = b.height * k
        const [ox, oy] = offsets[im.id] || [0, 0]
        g.imageSmoothingQuality = 'high'
        g.drawImage(b, x + (w - dw) / 2 + ox * (dw - w) / 2, y + (h - dh) / 2 + oy * (dh - h) / 2, dw, dh)
      } else { g.fillStyle = 'rgba(128,128,128,.25)'; g.fillRect(x, y, w, h) }
      g.restore()
    })
    return c
  }
  useEffect(() => { if (view.current) draw(view.current, 1000) })

  // drag inside a cell to choose what shows
  const drag = useRef<{ id: number; x: number; y: number; o: [number, number] } | null>(null)
  const cellAt = (e: React.PointerEvent): number => {
    const r = view.current!.getBoundingClientRect()
    const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height
    return lay.cells.findIndex(c => u >= c[0] && u <= c[0] + c[2] && v >= c[1] && v <= c[1] + c[3])
  }
  const make = async () => {
    setBusy(true)
    try {
      const c = draw(makeCanvas(1, 1), edge)
      const blob = await encode(c, 'jpeg', 0.92)
      const r: ImportResult = await uploadOne(new File([blob], `Collage ${new Date().toLocaleDateString()}.jpg`, { type: 'image/jpeg' }), { source: 'collage', title: `Collage of ${images.length}` })
      announceChange()
      const id = r.items[0]?.id || r.already[0]?.id
      if (id) navigate(`/edit/${id}`)
    } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }
  return (
    <div className="stack loose">
      <div className="lib-head">
        <div className="grow"><h2 className="page-title">Collage</h2><p className="muted small">Two to nine pictures in one. Drag inside a box to choose what shows. The collage becomes a new picture you can edit further.</p></div>
        <div className="row wrap">
          <button type="button" className="btn" onClick={() => setPicking(true)}><Icon name="images" size={15} />{images.length ? 'Change pictures' : 'Choose pictures'}</button>
          <button type="button" className="btn primary" disabled={images.length < 2 || busy} onClick={make}>{busy ? <><Spinner />Making…</> : <><Icon name="check" size={15} />Make the collage</>}</button>
        </div>
      </div>
      {images.length < 2 ? <Empty title="Choose 2 to 9 pictures" icon="collage"><button type="button" className="btn primary" onClick={() => setPicking(true)}>Choose pictures</button></Empty> : (
        <div className="collage">
          <div className="collage-view">
            <canvas ref={view} className="collage-canvas"
              onPointerDown={e => { const i = cellAt(e); const im = images[i]; if (!im) return; (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = { id: im.id, x: e.clientX, y: e.clientY, o: offsets[im.id] || [0, 0] } }}
              onPointerMove={e => { const d = drag.current; if (!d) return; const r = view.current!.getBoundingClientRect(); const k = 4 / Math.max(r.width, 1); setOffsets(o => ({ ...o, [d.id]: [Math.max(-1, Math.min(1, d.o[0] - (e.clientX - d.x) * k)), Math.max(-1, Math.min(1, d.o[1] - (e.clientY - d.y) * k))] })) }}
              onPointerUp={() => { drag.current = null }} />
          </div>
          <div className="collage-side">
            <Field group label="Layout"><div className="chips wrap">{layouts.map(l => <button type="button" key={l.id + l.label} className={`chip ${lay.id === l.id ? 'active' : ''}`} onClick={() => setLayout(l.id)}>{l.label}</button>)}</div></Field>
            <Field group label="Shape"><div className="chips wrap">{Object.keys(ASPECT).map(a => <button type="button" key={a} className={`chip ${aspect === a ? 'active' : ''}`} onClick={() => setAspect(a)}>{a === '1:1' ? 'Square' : a}</button>)}</div></Field>
            <Slider label="Space between" value={gap} min={0} max={8} step={0.25} unit="%" zero={2} onChange={setGap} onCommit={() => {}} />
            <Slider label="Rounded corners" value={radius} min={0} max={100} onChange={setRadius} onCommit={() => {}} />
            <Field group label="Background"><div className="swatches">{SWATCHES.slice(0, 10).map(c => <button type="button" key={c} className={`swatch ${bg === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setBg(c)} aria-label={c} />)}<label className="swatch custom"><input type="color" value={bg} onChange={e => setBg(e.target.value)} /><Icon name="plus" size={12} /></label></div></Field>
            <Field group label="Size"><Select ariaLabel="Size" value={String(edge)} onChange={v => setEdge(Number(v))} options={[{ value: '1600', label: '1600 px' }, { value: '2400', label: '2400 px' }, { value: '3600', label: '3600 px (print)' }]} /></Field>
          </div>
        </div>
      )}
      {picking && <LabPicker title="Pictures for the collage" max={9} initial={images.map(i => i.id)} onClose={() => setPicking(false)} onDone={ims => { setImages(ims); setPicking(false); setLayout('grid') }} />}
    </div>
  )
}
