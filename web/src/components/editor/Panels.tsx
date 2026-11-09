// The editor's tools, one panel each.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, V1 } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { Preset, Version } from '../../lib/types'
import {
  ADJUST_ZERO, ASPECTS, BAND_HUE, BANDS, FONTS, LOCAL_SLIDERS, LOOKS, STICKERS, SWATCHES, SLIDER_GROUPS, applyLook, clean, describe, lookPart, newId,
  type Adjust, type AdjustKey, type Band, type Crop, type Effects, type Frame, type ImageLayer, type Layer, type Mask, type Recipe, type TextLayer, type WatermarkLayer,
} from '../../lib/recipe'
import { loadFonts, uploadFont, type Font } from '../../lib/fonts'
import { findSubject } from '../../lib/cutout'
import { LabPicker } from '../Pickers'
import { cropSize, dataURL, drawGeometry, finalSize, imageSize, makeCanvas, renderBase } from '../../lib/render/engine'
import { autoAdjust, process } from '../../lib/render/pixels'
import { fmtBytes, fmtDateTime } from '../../lib/format'
import { sourceName } from '../../lib/images'
import { Icon } from '../icons'
import { Select } from '../Select'
import { Confirm, CoreHint, Field, Segmented, Spinner, Switch, useAsync, useToast, errMsg, copyText } from '../ui'
import { CurvesEditor } from './Curves'
import { Histogram } from './Histogram'
import { Slider } from './Slider'
import type { Ed } from './types'

function Group({ title, icon, children, open: initial = true, actions }: { title: string; icon?: string; children: React.ReactNode; open?: boolean; actions?: React.ReactNode }) {
  const [open, setOpen] = useState(initial)
  return (
    <section className={`pgroup ${open ? 'open' : ''}`}>
      <div className="pgroup-head">
        <button type="button" className="pgroup-btn" aria-expanded={open} onClick={() => setOpen(o => !o)}>{icon && <Icon name={icon} size={15} />}<span>{title}</span><Icon name="chevron-down" size={14} className="pgroup-caret" /></button>
        {actions}
      </div>
      {open && <div className="pgroup-body">{children}</div>}
    </section>
  )
}

function Swatches({ value, onChange, allowNone, label }: { value: string | null; onChange: (c: string | null) => void; allowNone?: boolean; label: string }) {
  return (
    <div className="swatches" role="group" aria-label={label}>
      {allowNone && <button type="button" className={`swatch none ${value === null ? 'active' : ''}`} onClick={() => onChange(null)} aria-label="None" title="None" />}
      {SWATCHES.map(c => <button type="button" key={c} className={`swatch ${value?.toLowerCase() === c ? 'active' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />)}
      <label className="swatch custom" title="Another colour"><input type="color" value={value && value.startsWith('#') && value.length === 7 ? value : '#ff8800'} onChange={e => onChange(e.target.value)} /><Icon name="plus" size={12} /></label>
    </div>
  )
}

const adj = (r: Recipe): Adjust => ({ ...ADJUST_ZERO, ...(r.adjust || {}) })

// ---- crop and rotate ----

function aspectRatio(id: string | undefined, FW: number, FH: number): number | null {
  if (!id || id === 'free') return null
  if (id === 'original') return FW / FH
  return ASPECTS.find(a => a.id === id)?.ratio || null
}

export function fitAspect(id: string, FW: number, FH: number, cur?: Crop | null): Crop {
  const ratio = aspectRatio(id, FW, FH)
  if (!ratio) return { ...(cur || { x: 0, y: 0, w: 1, h: 1 }), aspect: id }
  let w = 1, h = FW / (ratio * FH)
  if (h > 1) { h = 1; w = (ratio * FH) / FW }
  const cx = cur ? cur.x + cur.w / 2 : 0.5, cy = cur ? cur.y + cur.h / 2 : 0.5
  const x = Math.max(0, Math.min(1 - w, cx - w / 2)), y = Math.max(0, Math.min(1 - h, cy - h / 2))
  return { x, y, w, h, aspect: id }
}
const flipAspect = (a?: string) => a && /^\d+:\d+$/.test(a) ? a.split(':').reverse().join(':') : a

export function CropPanel({ ed }: { ed: Ed }) {
  const r = ed.recipe
  const [ow, oh] = [ed.src.width, ed.src.height]
  const turned = ((r.rotate || 0) / 90) % 2 === 1
  const FW = turned ? oh : ow, FH = turned ? ow : oh
  const c = r.crop || { x: 0, y: 0, w: 1, h: 1 }
  const [cw, ch] = cropSize(r, ow, oh)
  const turn = (dir: 1 | -1) => {
    const n = { ...c }
    const nc: Crop = dir === 1 ? { x: 1 - n.y - n.h, y: n.x, w: n.h, h: n.w, aspect: flipAspect(n.aspect) } : { x: n.y, y: 1 - n.x - n.w, w: n.h, h: n.w, aspect: flipAspect(n.aspect) }
    ed.commit({ ...r, rotate: ((r.rotate || 0) + (dir === 1 ? 90 : 270)) % 360, crop: r.crop ? nc : null, resize: null })
  }
  return (
    <div className="panel-body">
      <Group title="Shape" icon="aspect">
        <div className="chips wrap">
          {ASPECTS.map(a => <button type="button" key={a.id} className={`chip ${(c.aspect || 'free') === a.id ? 'active' : ''}`} onClick={() => ed.commit({ ...r, crop: fitAspect(a.id, FW, FH, a.id === 'free' ? c : null), resize: null })}>{a.label}</button>)}
        </div>
        <p className="muted small">Drag the corners or the edges of the box; drag inside it to move it. {Math.round(cw)}×{Math.round(ch)} pixels.</p>
      </Group>
      <Group title="Turn and mirror" icon="rotate-right">
        <div className="tool-row">
          <button type="button" className="btn" onClick={() => turn(-1)} title="Turn left"><Icon name="rotate-left" size={16} />Left</button>
          <button type="button" className="btn" onClick={() => turn(1)} title="Turn right"><Icon name="rotate-right" size={16} />Right</button>
          <button type="button" className={`btn ${r.flipH ? 'active-toggle' : ''}`} aria-pressed={!!r.flipH} onClick={() => ed.commit({ ...r, flipH: !r.flipH, crop: r.crop ? { ...c, x: 1 - c.x - c.w } : null })} title="Mirror left to right"><Icon name="flip-h" size={16} />Mirror</button>
          <button type="button" className={`btn ${r.flipV ? 'active-toggle' : ''}`} aria-pressed={!!r.flipV} onClick={() => ed.commit({ ...r, flipV: !r.flipV, crop: r.crop ? { ...c, y: 1 - c.y - c.h } : null })} title="Upside down"><Icon name="flip-v" size={16} />Flip</button>
        </div>
        <Slider label="Straighten" value={r.straighten || 0} min={-45} max={45} step={0.1} unit="°" onDraft={ed.setDraft} onChange={v => ed.set({ ...r, straighten: v })} onCommit={() => ed.commit()} help="Turns the picture a little so the horizon is level; the edges are filled by zooming in." />
      </Group>
      <Group title="Perspective" icon="frame" open={!!r.perspective}>
        <p className="muted small">Make leaning buildings stand upright, or a photographed page square.</p>
        <Slider label="Upright (vertical)" value={r.perspective?.v || 0} min={-100} max={100} onDraft={ed.setDraft} onChange={v => ed.set({ ...r, perspective: { v, h: r.perspective?.h || 0 } })} onCommit={() => ed.commit()} help="Right: lines that lean in at the top stand straight; left: at the bottom." />
        <Slider label="Sideways (horizontal)" value={r.perspective?.h || 0} min={-100} max={100} onDraft={ed.setDraft} onChange={h => ed.set({ ...r, perspective: { v: r.perspective?.v || 0, h } })} onCommit={() => ed.commit()} />
      </Group>
      <button type="button" className="btn ghost" onClick={() => ed.commit({ ...r, crop: null, rotate: 0, flipH: false, flipV: false, straighten: 0, perspective: null, resize: null })}><Icon name="refresh" size={15} />Reset crop, turns and perspective</button>
    </div>
  )
}

// ---- light and colour ----

export function AdjustPanel({ ed, histo }: { ed: Ed; histo: { canvas: HTMLCanvasElement | null; version: number } }) {
  const { settings } = useApp()
  const { toast } = useToast()
  const r = ed.recipe
  const a = adj(r)
  const [wish, setWish] = useState('')
  const [ai, setAi] = useState<{ busy: boolean; why?: string; error?: string }>({ busy: false })
  const { data: aiStatus } = useAsync(() => api.get<{ ready: boolean; detail: string }>(`${V1}/ai/status`), [])
  const aiOff = !settings?.ai_photos ? 'Sending pictures to the AI is switched off (Settings → AI).' : aiStatus && !aiStatus.ready ? `No AI is set up${aiStatus.detail ? `: ${aiStatus.detail}` : ''} (Settings → AI).` : ''
  const setKey = (k: AdjustKey, v: number) => ed.set({ ...r, adjust: { ...(r.adjust || {}), [k]: v } })
  const plain = async (edge: number) => (await renderBase(ed.src, ed.src.width, ed.src.height, { ...r, adjust: {}, look: null, curves: null, hsl: null, split: null, effects: null, layers: [] }, { maxEdge: edge, noPixels: true }))
  const auto = async () => {
    const c = await plain(400)
    const px = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data
    ed.commit({ ...r, adjust: { ...(r.adjust || {}), ...autoAdjust(px) } })
    toast('Levels and white balance set from the picture')
  }
  const suggest = async () => {
    setAi({ busy: true })
    try {
      const c = await plain(768)
      const res = await api.post<{ ok: boolean; error?: string; adjust?: Partial<Adjust>; look?: string; look_strength?: number; straighten?: number; crop?: Crop & { aspect?: string }; why?: string }>(`${V1}/ai/suggest`, { image: dataURL(c, 768, 0.82), wish })
      if (!res.ok) { setAi({ busy: false, error: res.error }); return }
      const next: Recipe = { ...r, adjust: { ...ADJUST_ZERO, ...(res.adjust || {}) } }
      if (res.look && res.look !== 'none' && LOOKS.some(l => l.name === res.look)) next.look = { name: res.look, strength: res.look_strength || 60 }
      if (res.straighten) next.straighten = res.straighten
      if (res.crop) next.crop = { x: res.crop.x, y: res.crop.y, w: res.crop.w, h: res.crop.h, aspect: res.crop.aspect && res.crop.aspect !== 'free' ? res.crop.aspect : 'free' }
      ed.commit(next)
      setAi({ busy: false, why: res.why || 'Done.' })
    } catch (e) { setAi({ busy: false, error: errMsg(e) }) }
  }
  return (
    <div className="panel-body">
      {settings?.histogram !== false && <Histogram source={histo.canvas} version={histo.version} />}
      <div className="tool-row">
        <button type="button" className="btn" onClick={auto} title="Set levels and white balance from the picture"><Icon name="wand" size={15} />Auto</button>
        <button type="button" className="btn ghost" disabled={!r.adjust || Object.keys(r.adjust).length === 0} onClick={() => ed.commit({ ...r, adjust: {} })}><Icon name="refresh" size={15} />Reset</button>
      </div>
      <Group title="Ask the AI" icon="sparkles" open={false}>
        <div className="ai-row">
          <input value={wish} onChange={e => setWish(e.target.value)} placeholder="Optional: warmer, brighter, moody, for Instagram…" onKeyDown={e => { if (e.key === 'Enter') suggest() }} />
          <button type="button" className="btn" onClick={suggest} disabled={ai.busy || !!aiOff} title={aiOff || undefined}>{ai.busy ? <Spinner /> : <Icon name="sparkles" size={15} />}Suggest</button>
        </div>
        {aiOff && <p className="muted small">{aiOff}{!settings?.core_configured && <CoreHint />}</p>}
        {ai.why && <p className="ai-why small"><Icon name="sparkles" size={13} />{ai.why} <span className="muted">(undo with ⌘Z)</span></p>}
        {ai.error && <p className="bad small">{ai.error}</p>}
        <p className="muted small">A small copy of the picture goes to {settings?.ai_provider === 'openai' ? 'your OpenAI key' : 'Pocket AI'}; it sets the sliders, a look and the horizon for you.</p>
      </Group>
      {SLIDER_GROUPS.map(g => (
        <Group key={g.title} title={g.title} icon={g.icon} open={g.title !== 'Finish' && g.title !== 'Detail' ? true : Object.values(r.adjust || {}).length > 0 && g.sliders.some(s => !!r.adjust?.[s.key])}>
          {g.sliders.map(s => <Slider key={s.key} label={s.label} value={a[s.key]} min={s.min} max={s.max} unit={s.unit} help={s.help} onDraft={ed.setDraft} onChange={v => setKey(s.key, v)} onCommit={() => ed.commit()}
            gradient={s.key === 'temperature' ? 'linear-gradient(to right, #4a8fe7, #e6e6e6, #f2c14e)' : s.key === 'tint' ? 'linear-gradient(to right, #4caf50, #e6e6e6, #d63ad6)' : s.key === 'hue' ? 'linear-gradient(to right, #f33, #ff3, #3f3, #3ff, #33f, #f3f, #f33)' : undefined} />)}
        </Group>
      ))}
    </div>
  )
}

export function ColorPanel({ ed }: { ed: Ed }) {
  const r = ed.recipe
  const [band, setBand] = useState<Band>('orange')
  const b = r.hsl?.[band] || { h: 0, s: 0, l: 0 }
  const setBandVal = (k: 'h' | 's' | 'l', v: number) => ed.set({ ...r, hsl: { ...(r.hsl || {}), [band]: { ...b, [k]: v } } })
  const sp = r.split || { sh: 210, ss: 0, hh: 40, hs: 0, balance: 0 }
  const setSplit = (k: keyof typeof sp, v: number) => ed.set({ ...r, split: { ...sp, [k]: v } })
  const rainbow = 'linear-gradient(to right, #f33 0%, #ff3 17%, #3f3 33%, #3ff 50%, #33f 67%, #f3f 83%, #f33 100%)'
  return (
    <div className="panel-body">
      <Group title="Curves" icon="activity">
        <CurvesEditor value={r.curves} onChange={cv => ed.set({ ...r, curves: cv })} onCommit={() => ed.commit()} />
      </Group>
      <Group title="Colour mixer" icon="palette" actions={r.hsl && Object.keys(r.hsl).length > 0 ? <button type="button" className="btn ghost sm" onClick={() => ed.commit({ ...r, hsl: null })}>Reset</button> : undefined}>
        <div className="bands" role="group" aria-label="Colour">
          {BANDS.map(k => <button type="button" key={k} className={`band ${band === k ? 'active' : ''} ${r.hsl?.[k] && (r.hsl[k]!.h || r.hsl[k]!.s || r.hsl[k]!.l) ? 'changed' : ''}`} style={{ ['--band' as string]: `hsl(${BAND_HUE[k]} 80% 50%)` }} onClick={() => setBand(k)} title={k} aria-label={k} />)}
        </div>
        <p className="muted small">{band[0].toUpperCase() + band.slice(1)}s in the picture</p>
        <Slider label="Hue" value={b.h} min={-100} max={100} onDraft={ed.setDraft} onChange={v => setBandVal('h', v)} onCommit={() => ed.commit()} />
        <Slider label="Saturation" value={b.s} min={-100} max={100} onDraft={ed.setDraft} onChange={v => setBandVal('s', v)} onCommit={() => ed.commit()} />
        <Slider label="Lightness" value={b.l} min={-100} max={100} onDraft={ed.setDraft} onChange={v => setBandVal('l', v)} onCommit={() => ed.commit()} />
      </Group>
      <Group title="Split toning" icon="contrast" open={!!r.split} actions={r.split ? <button type="button" className="btn ghost sm" onClick={() => ed.commit({ ...r, split: null })}>Reset</button> : undefined}>
        <p className="muted small">A colour in the shadows and another in the highlights, like a film print.</p>
        <Slider label="Shadows colour" value={sp.sh} min={0} max={360} unit="°" zero={210} gradient={rainbow} onDraft={ed.setDraft} onChange={v => setSplit('sh', v)} onCommit={() => ed.commit()} />
        <Slider label="Shadows amount" value={sp.ss} min={0} max={100} onDraft={ed.setDraft} onChange={v => setSplit('ss', v)} onCommit={() => ed.commit()} />
        <Slider label="Highlights colour" value={sp.hh} min={0} max={360} unit="°" zero={40} gradient={rainbow} onDraft={ed.setDraft} onChange={v => setSplit('hh', v)} onCommit={() => ed.commit()} />
        <Slider label="Highlights amount" value={sp.hs} min={0} max={100} onDraft={ed.setDraft} onChange={v => setSplit('hs', v)} onCommit={() => ed.commit()} />
        <Slider label="Balance" value={sp.balance} min={-100} max={100} onDraft={ed.setDraft} onChange={v => setSplit('balance', v)} onCommit={() => ed.commit()} />
      </Group>
    </div>
  )
}

// ---- looks ----

/** Small previews of the current picture in every look. */
function useLookThumbs(ed: Ed, presets: Preset[] | null) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const key = JSON.stringify({ c: ed.recipe.crop, r: ed.recipe.rotate, f: [ed.recipe.flipH, ed.recipe.flipV], s: ed.recipe.straighten, a: ed.recipe.adjust, cv: ed.recipe.curves, h: ed.recipe.hsl, sp: ed.recipe.split, p: presets?.map(p => p.id) })
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      const base = drawGeometry(ed.src, ed.src.width, ed.src.height, ed.recipe, Math.min(1, 150 / Math.max(...cropSize(ed.recipe, ed.src.width, ed.src.height))))
      const px0 = base.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, base.width, base.height)
      const out: Record<string, string> = {}
      const make = (rec: Recipe) => {
        const data = new ImageData(new Uint8ClampedArray(px0.data), base.width, base.height)
        process(data.data, base.width, base.height, rec)
        const c = makeCanvas(base.width, base.height); c.getContext('2d')!.putImageData(data, 0, 0)
        return c.toDataURL('image/jpeg', 0.8)
      }
      const own: Recipe = { adjust: ed.recipe.adjust, curves: ed.recipe.curves, hsl: ed.recipe.hsl, split: ed.recipe.split }
      out[''] = make(own)
      for (const l of LOOKS) { if (!alive) return; out[l.name] = make({ ...own, look: { name: l.name, strength: 100 } }) }
      for (const p of presets || []) out[`p${p.id}`] = make(applyLook({}, p.recipe))
      if (alive) setThumbs(out)
    }, 120)
    return () => { alive = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return thumbs
}

export function LooksPanel({ ed }: { ed: Ed }) {
  const { toast } = useToast()
  const r = ed.recipe
  const { data: presets, reload } = useAsync(() => api.get<Preset[]>(`${V1}/presets`), [])
  const thumbs = useLookThumbs(ed, presets || null)
  const [name, setName] = useState('')
  const [naming, setNaming] = useState(false)
  const cur = r.look?.name || ''
  const save = async () => {
    const v = ed.view()
    try { await api.post(`${V1}/presets`, { name: name.trim(), recipe: lookPart(r), thumb: v ? dataURL(v, 240) : '' }); toast(`Saved the look “${name.trim()}”`); setNaming(false); setName(''); reload() } catch (e) { toast(errMsg(e), 'err') }
  }
  return (
    <div className="panel-body">
      <Group title="Looks" icon="palette">
        <div className="look-grid">
          <button type="button" className={`look ${!cur ? 'active' : ''}`} onClick={() => ed.commit({ ...r, look: null })}>{thumbs[''] ? <img src={thumbs['']} alt="" /> : <span className="look-ph" />}<span>None</span></button>
          {LOOKS.map(l => <button type="button" key={l.name} className={`look ${cur === l.name ? 'active' : ''}`} onClick={() => ed.commit({ ...r, look: { name: l.name, strength: cur === l.name ? r.look!.strength : 80 } })}>{thumbs[l.name] ? <img src={thumbs[l.name]} alt="" /> : <span className="look-ph" />}<span>{l.label}</span></button>)}
        </div>
        {cur && <Slider label="Strength" value={r.look?.strength ?? 80} min={0} max={100} unit="%" zero={80} onDraft={ed.setDraft} onChange={v => ed.set({ ...r, look: { name: cur, strength: v } })} onCommit={() => ed.commit()} />}
      </Group>
      <Group title="Your looks" icon="star" actions={<button type="button" className="btn ghost sm" onClick={() => setNaming(true)}><Icon name="plus" size={14} />Save this look</button>}>
        {naming && <div className="ai-row"><input value={name} onChange={e => setName(e.target.value)} placeholder="Name, e.g. Warm evening" autoFocus onKeyDown={e => { if (e.key === 'Enter' && name.trim()) save(); if (e.key === 'Escape') setNaming(false) }} /><button type="button" className="btn primary" disabled={!name.trim()} onClick={save}>Save</button></div>}
        {presets && presets.length === 0 && !naming && <p className="muted small">Light, colour and effects you like, saved to put on any picture (here, or many at once from Your pictures → Select).</p>}
        <div className="look-grid">
          {presets?.map(p => <button type="button" key={p.id} className="look" onClick={() => ed.commit(applyLook(r, p.recipe))} title={`Put “${p.name}” on this picture`}>{thumbs[`p${p.id}`] ? <img src={thumbs[`p${p.id}`]} alt="" /> : <span className="look-ph" />}<span>{p.name}</span></button>)}
        </div>
      </Group>
    </div>
  )
}

// ---- effects ----

const DUOS = [{ dark: '#1b1f3b', light: '#f8c58c' }, { dark: '#2b1055', light: '#7597de' }, { dark: '#0b3d2e', light: '#d9f99d' }, { dark: '#3d0c11', light: '#ffd6a5' }, { dark: '#000000', light: '#ff4d6d' }, { dark: '#102a43', light: '#9fb3c8' }]

export function EffectsPanel({ ed }: { ed: Ed }) {
  const r = ed.recipe
  const fx: Effects = r.effects || {}
  const setFx = (p: Partial<Effects>, commit = true) => { const n = { ...r, effects: { ...fx, ...p } }; if (commit) ed.commit(n); else ed.set(n) }
  return (
    <div className="panel-body">
      <Group title="Black and white, tones" icon="contrast">
        <div className="set-row"><span>Black and white</span><Switch checked={!!fx.mono} onChange={v => setFx({ mono: v })} label="Black and white" /></div>
        <Slider label="Sepia" value={fx.sepia || 0} min={0} max={100} onDraft={ed.setDraft} onChange={v => setFx({ sepia: v }, false)} onCommit={() => ed.commit()} />
        <div className="field-label small">Duotone</div>
        <div className="duos">
          <button type="button" className={`duo none ${!fx.duotone ? 'active' : ''}`} onClick={() => setFx({ duotone: null })}>Off</button>
          {DUOS.map(d => <button type="button" key={d.dark + d.light} className={`duo ${fx.duotone?.dark === d.dark && fx.duotone?.light === d.light ? 'active' : ''}`} style={{ background: `linear-gradient(135deg, ${d.dark}, ${d.light})` }} onClick={() => setFx({ duotone: d })} aria-label="Duotone" />)}
        </div>
        {fx.duotone && <div className="row"><label className="color-pick">Dark <input type="color" value={fx.duotone.dark} onChange={e => setFx({ duotone: { ...fx.duotone!, dark: e.target.value } }, false)} onBlur={() => ed.commit()} /></label><label className="color-pick">Light <input type="color" value={fx.duotone.light} onChange={e => setFx({ duotone: { ...fx.duotone!, light: e.target.value } }, false)} onBlur={() => ed.commit()} /></label></div>}
        <div className="set-row"><span>Negative</span><Switch checked={!!fx.invert} onChange={v => setFx({ invert: v })} label="Negative" /></div>
      </Group>
      <Group title="Creative" icon="sparkles">
        <Slider label="Posterize" value={fx.posterize || 0} min={0} max={16} help="Fewer colour steps, like a screen print (0 = off)." onDraft={ed.setDraft} onChange={v => setFx({ posterize: v === 1 ? 2 : v }, false)} onCommit={() => ed.commit()} />
        <Slider label="Pixelate" value={fx.pixelate || 0} min={0} max={100} onDraft={ed.setDraft} onChange={v => setFx({ pixelate: v }, false)} onCommit={() => ed.commit()} />
        <div className="set-row"><span>Miniature (tilt-shift)</span><Switch checked={!!fx.tilt} onChange={v => setFx({ tilt: v ? { y: 0.55, band: 0.22, blur: 60 } : null })} label="Miniature" /></div>
        {fx.tilt && <>
          <Slider label="Sharp band: where" value={Math.round(fx.tilt.y * 100)} min={0} max={100} zero={55} unit="%" onDraft={ed.setDraft} onChange={v => setFx({ tilt: { ...fx.tilt!, y: v / 100 } }, false)} onCommit={() => ed.commit()} />
          <Slider label="Sharp band: height" value={Math.round(fx.tilt.band * 100)} min={2} max={80} zero={22} unit="%" onDraft={ed.setDraft} onChange={v => setFx({ tilt: { ...fx.tilt!, band: v / 100 } }, false)} onCommit={() => ed.commit()} />
          <Slider label="Blur" value={fx.tilt.blur} min={5} max={100} zero={60} onDraft={ed.setDraft} onChange={v => setFx({ tilt: { ...fx.tilt!, blur: v } }, false)} onCommit={() => ed.commit()} />
        </>}
      </Group>
      <Group title="Make a colour see-through" icon="droplet" open={!!fx.key}>
        <p className="muted small">For a logo or a signature on white paper: the colour you pick disappears (save as PNG or WebP to keep it see-through).</p>
        <div className="set-row"><span>On</span><Switch checked={!!fx.key} onChange={v => setFx({ key: v ? { color: '#ffffff', tolerance: 25 } : null })} label="See-through colour" /></div>
        {fx.key && <>
          <div className="row"><Swatches label="Colour" value={fx.key.color} onChange={c => setFx({ key: { ...fx.key!, color: c || '#ffffff' } })} />
            {'EyeDropper' in window && <button type="button" className="btn sm" onClick={async () => { try { const res = await new (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper().open(); setFx({ key: { ...fx.key!, color: res.sRGBHex } }) } catch { /* cancelled */ } }}><Icon name="eye-dropper" size={14} />Pick</button>}</div>
          <Slider label="Tolerance" value={fx.key.tolerance} min={0} max={100} zero={25} onDraft={ed.setDraft} onChange={v => setFx({ key: { ...fx.key!, tolerance: v } }, false)} onCommit={() => ed.commit()} />
        </>}
      </Group>
    </div>
  )
}

// ---- text, stickers, watermark ----

export function TextPanel({ ed }: { ed: Ed }) {
  const { toast } = useToast()
  const r = ed.recipe
  const [fonts, setFonts] = useState<Font[]>([])
  useEffect(() => { loadFonts().then(setFonts) }, [])
  const [picking, setPicking] = useState(false)
  const pic = (r.layers || []).find(l => l.id === ed.selected && l.type === 'image') as ImageLayer | undefined
  const texts = (r.layers || []).filter(l => l.type === 'text') as TextLayer[]
  const sel = (r.layers || []).find(l => l.id === ed.selected)
  const t = sel?.type === 'text' ? sel : null
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const h = (e: Event) => { const id = (e as CustomEvent<string>).detail; ed.select(id); setTimeout(() => { area.current?.focus(); area.current?.select() }, 30) }; window.addEventListener('plab:edit-text', h); return () => window.removeEventListener('plab:edit-text', h) })
  const add = () => {
    const l: TextLayer = { id: newId(), type: 'text', x: 0.5, y: 0.5 + ((texts.length % 4) * 0.08), text: 'Your text', font: 'sans', size: 0.08, color: '#ffffff', bold: true, align: 'center', shadow: true, opacity: 1 }
    ed.addLayer(l)
    setTimeout(() => { area.current?.focus(); area.current?.select() }, 50)
  }
  const up = (p: Partial<TextLayer>, commit = true) => t && ed.updateLayer(t.id, p, commit)
  const wm = (r.layers || []).find(l => l.type === 'watermark') as WatermarkLayer | undefined
  const setWm = (p: Partial<WatermarkLayer> | null, commit = true) => {
    if (p === null) { if (wm) ed.removeLayer(wm.id); return }
    if (wm) ed.updateLayer(wm.id, p, commit)
    else ed.addLayer({ id: newId(), type: 'watermark', text: '© ' + new Date().getFullYear(), size: 0.035, color: '#ffffff', tile: false, corner: 'br', opacity: 0.7, ...p } as WatermarkLayer)
  }
  return (
    <div className="panel-body">
      <button type="button" className="btn primary block-btn" onClick={add}><Icon name="type" size={15} />Add text</button>
      {texts.length > 1 && <div className="chips wrap">{texts.map(x => <button type="button" key={x.id} className={`chip ${ed.selected === x.id ? 'active' : ''}`} onClick={() => ed.select(x.id)}>{x.text.split('\n')[0].slice(0, 16) || '…'}</button>)}</div>}
      {t ? <>
        <Field label="Text"><textarea ref={area} rows={2} value={t.text} onChange={e => up({ text: e.target.value }, false)} onBlur={() => ed.commit()} /></Field>
        <div className="font-grid">{FONTS.map(f => <button type="button" key={f.id} className={`font-btn ${t.font === f.id ? 'active' : ''}`} style={{ fontFamily: f.css }} onClick={() => up({ font: f.id })}>{f.label}</button>)}
          {fonts.map(f => <button type="button" key={f.id} className={`font-btn ${t.font === `f:${f.id}` ? 'active' : ''}`} style={{ fontFamily: `"plab-font-${f.id}", sans-serif` }} onClick={() => up({ font: `f:${f.id}` })} title={f.name}>{f.name}</button>)}
          <label className="font-btn add" title="Add a font of your own (TTF, OTF, WOFF)"><Icon name="plus" size={13} />Font<input type="file" accept=".ttf,.otf,.woff,.woff2,font/*" hidden onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { const nf = await uploadFont(f); setFonts(await loadFonts()); up({ font: `f:${nf.id}` }) } catch (err) { toast(errMsg(err), 'err') } }} /></label>
        </div>
        <Slider label="Size" value={Math.round(t.size * 1000) / 10} min={1} max={40} step={0.5} unit="%" zero={8} onChange={v => up({ size: v / 100 }, false)} onCommit={() => ed.commit()} />
        <Swatches label="Colour" value={t.color} onChange={c => up({ color: c || '#ffffff' })} />
        <div className="tool-row">
          <button type="button" className={`btn icon-only ${t.bold ? 'active-toggle' : ''}`} aria-pressed={!!t.bold} onClick={() => up({ bold: !t.bold })} title="Bold"><b>B</b></button>
          <button type="button" className={`btn icon-only ${t.italic ? 'active-toggle' : ''}`} aria-pressed={!!t.italic} onClick={() => up({ italic: !t.italic })} title="Italic"><i>I</i></button>
          <Segmented size="sm" value={t.align || 'center'} onChange={v => up({ align: v })} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }]} />
        </div>
        <div className="set-row"><span>Shadow</span><Switch checked={!!t.shadow} onChange={v => up({ shadow: v })} label="Shadow" /></div>
        <div className="field-label small">Outline</div>
        <Swatches label="Outline" allowNone value={t.outline || null} onChange={c => up({ outline: c })} />
        <div className="field-label small">Box behind</div>
        <Swatches label="Box behind" allowNone value={t.bg || null} onChange={c => up({ bg: c ? c + (c.length === 7 ? 'cc' : '') : null })} />
        <Slider label="Turn" value={t.rotate || 0} min={-180} max={180} unit="°" onChange={v => up({ rotate: v }, false)} onCommit={() => ed.commit()} />
        <Slider label="Opacity" value={Math.round((t.opacity ?? 1) * 100)} min={5} max={100} zero={100} unit="%" onChange={v => up({ opacity: v / 100 }, false)} onCommit={() => ed.commit()} />
        <div className="tool-row">
          <button type="button" className="btn" onClick={() => ed.addLayer({ ...t, id: newId(), x: Math.min(0.95, t.x + 0.04), y: Math.min(0.95, t.y + 0.04) })}><Icon name="copy" size={14} />Duplicate</button>
          <button type="button" className="btn danger-text" onClick={() => ed.removeLayer(t.id)}><Icon name="trash" size={14} />Remove</button>
        </div>
      </> : <p className="muted small">{texts.length ? 'Tap a text on the picture to change it; drag to move it, drag its corner to resize it.' : 'Add a caption, a date or a title. Drag it where you want it.'}</p>}
      <Group title="Stickers" icon="sticker" open={false}>
        <div className="stickers">{STICKERS.map(s => <button type="button" key={s} className="sticker-btn" onClick={() => ed.addLayer({ id: newId(), type: 'sticker', x: 0.5, y: 0.5, emoji: s, size: 0.16, rotate: 0 })}>{s}</button>)}</div>
        {sel?.type === 'sticker' && <>
          <Slider label="Sticker size" value={Math.round(sel.size * 100)} min={2} max={100} zero={16} unit="%" onChange={v => ed.updateLayer(sel.id, { size: v / 100 }, false)} onCommit={() => ed.commit()} />
          <Slider label="Turn" value={sel.rotate || 0} min={-180} max={180} unit="°" onChange={v => ed.updateLayer(sel.id, { rotate: v }, false)} onCommit={() => ed.commit()} />
          <button type="button" className="btn danger-text" onClick={() => ed.removeLayer(sel.id)}><Icon name="trash" size={14} />Remove sticker</button>
        </>}
      </Group>
      <Group title="A picture on top" icon="image" open={!!pic}>
        <p className="muted small">Your logo, a signature, or a second photo from the lab (see-through parts stay see-through).</p>
        <button type="button" className="btn" onClick={() => setPicking(true)}><Icon name="plus" size={14} />Add a picture</button>
        {pic && <>
          <Slider label="Size" value={Math.round(pic.w * 100)} min={2} max={150} zero={30} unit="%" onChange={v => ed.updateLayer(pic.id, { w: v / 100 }, false)} onCommit={() => ed.commit()} />
          <Slider label="Turn" value={pic.rotate || 0} min={-180} max={180} unit="°" onChange={v => ed.updateLayer(pic.id, { rotate: v }, false)} onCommit={() => ed.commit()} />
          <Slider label="Opacity" value={Math.round((pic.opacity ?? 1) * 100)} min={5} max={100} zero={100} unit="%" onChange={v => ed.updateLayer(pic.id, { opacity: v / 100 }, false)} onCommit={() => ed.commit()} />
          <button type="button" className="btn danger-text" onClick={() => ed.removeLayer(pic.id)}><Icon name="trash" size={14} />Remove the picture</button>
        </>}
        {picking && <LabPicker title="A picture to put on top" max={1} onClose={() => setPicking(false)} onDone={ims => {
          setPicking(false)
          const im = ims[0]
          if (!im || im.id === ed.image.id) return
          ed.addLayer({ id: newId(), type: 'image', src: im.id, updated: im.updated_at, x: 0.5, y: 0.5, w: 0.3, aspect: im.height && im.width ? im.height / im.width : 1, opacity: 1 } as ImageLayer)
        }} />}
      </Group>
      <Group title="Watermark" icon="watermark" open={!!wm}>
        <div className="set-row"><span>On</span><Switch checked={!!wm} onChange={v => setWm(v ? {} : null)} label="Watermark" /></div>
        {wm && <>
          <Field label="Text"><input value={wm.text} onChange={e => setWm({ text: e.target.value }, false)} onBlur={() => ed.commit()} /></Field>
          <Segmented size="sm" value={wm.tile ? 'tile' : wm.corner} onChange={v => setWm(v === 'tile' ? { tile: true } : { tile: false, corner: v as WatermarkLayer['corner'] })} options={[{ value: 'br', label: '↘' }, { value: 'bl', label: '↙' }, { value: 'tr', label: '↗' }, { value: 'tl', label: '↖' }, { value: 'c', label: 'Centre' }, { value: 'tile', label: 'All over' }]} />
          <Slider label="Size" value={Math.round(wm.size * 1000) / 10} min={1} max={15} step={0.5} unit="%" zero={3.5} onChange={v => setWm({ size: v / 100 }, false)} onCommit={() => ed.commit()} />
          <Slider label="Opacity" value={Math.round((wm.opacity ?? 0.7) * 100)} min={5} max={100} zero={70} unit="%" onChange={v => setWm({ opacity: v / 100 }, false)} onCommit={() => ed.commit()} />
          <Swatches label="Colour" value={wm.color} onChange={c => setWm({ color: c || '#ffffff' })} />
        </>}
      </Group>
    </div>
  )
}

// ---- drawing and shapes ----

export function DrawPanel({ ed }: { ed: Ed }) {
  const r = ed.recipe
  const sel = (r.layers || []).find(l => l.id === ed.selected && ['draw', 'rect', 'ellipse', 'line', 'arrow'].includes(l.type))
  const b = ed.brush
  const setB = (p: Partial<typeof b>) => {
    ed.setBrush({ ...b, ...p })
    if (sel) {
      const U = Math.min(ed.base.w || 1, ed.base.h || 1)
      const patch: Partial<Layer> = {}
      if (p.color) (patch as { stroke?: string }).stroke = p.color
      if (p.width !== undefined) (patch as { width?: number }).width = (sel.type === 'draw' && (sel as { marker?: boolean }).marker ? p.width * 3 : p.width) / U
      if (p.opacity !== undefined) patch.opacity = p.opacity
      if (p.fill !== undefined && (sel.type === 'rect' || sel.type === 'ellipse')) (patch as { fill?: string | null }).fill = p.fill
      ed.updateLayer(sel.id, patch, p.width === undefined && p.opacity === undefined)
    }
  }
  const drawings = (r.layers || []).filter(l => ['draw', 'rect', 'ellipse', 'line', 'arrow'].includes(l.type))
  const modes: { value: typeof ed.drawMode; icon: string; label: string }[] = [
    { value: 'select', icon: 'move', label: 'Move' }, { value: 'brush', icon: 'brush', label: 'Pen' }, { value: 'marker', icon: 'highlighter', label: 'Marker' },
    { value: 'rect', icon: 'square', label: 'Box' }, { value: 'ellipse', icon: 'circle-o', label: 'Circle' }, { value: 'line', icon: 'slash', label: 'Line' }, { value: 'arrow', icon: 'arrow-ur', label: 'Arrow' },
  ]
  return (
    <div className="panel-body">
      <div className="mode-grid">{modes.map(m => <button type="button" key={m.value} className={`mode-btn ${ed.drawMode === m.value ? 'active' : ''}`} aria-pressed={ed.drawMode === m.value} onClick={() => ed.setDrawMode(m.value)}><Icon name={m.icon} size={17} /><span>{m.label}</span></button>)}</div>
      <p className="muted small">{ed.drawMode === 'select' ? 'Tap a drawing to pick it, then drag it.' : ed.drawMode === 'brush' || ed.drawMode === 'marker' ? 'Draw on the picture with your finger or the mouse.' : 'Drag on the picture to draw it.'}</p>
      <Swatches label="Colour" value={b.color} onChange={c => setB({ color: c || '#f03e3e' })} />
      <Slider label="Thickness" value={b.width} min={1} max={60} zero={6} onChange={v => setB({ width: v })} onCommit={() => sel && ed.commit()} />
      <Slider label="Opacity" value={Math.round(b.opacity * 100)} min={5} max={100} zero={100} unit="%" onChange={v => setB({ opacity: v / 100 })} onCommit={() => sel && ed.commit()} />
      {(ed.drawMode === 'rect' || ed.drawMode === 'ellipse' || sel?.type === 'rect' || sel?.type === 'ellipse') && <><div className="field-label small">Fill</div><Swatches label="Fill" allowNone value={b.fill} onChange={c => setB({ fill: c })} /></>}
      <div className="tool-row">
        {sel && <button type="button" className="btn danger-text" onClick={() => ed.removeLayer(sel.id)}><Icon name="trash" size={14} />Remove this</button>}
        {drawings.length > 0 && <button type="button" className="btn ghost" onClick={() => ed.commit({ ...r, layers: (r.layers || []).filter(l => !['draw', 'rect', 'ellipse', 'line', 'arrow'].includes(l.type)) })}><Icon name="eraser" size={14} />Clear all drawing</button>}
      </div>
    </div>
  )
}

// ---- hiding faces, plates, addresses ----

export function HidePanel({ ed }: { ed: Ed }) {
  const r = ed.recipe
  const areas = (r.layers || []).filter(l => l.type === 'redact')
  const sel = areas.find(l => l.id === ed.selected)
  const o = ed.redact
  const setO = (p: Partial<typeof o>, commit = true) => {
    ed.setRedact({ ...o, ...p })
    if (sel) ed.updateLayer(sel.id, p as Partial<Layer>, commit)
  }
  return (
    <div className="panel-body">
      <p className="small">Drag over a face, a number plate, an address or a screen to hide it. Nothing underneath can be recovered from the saved picture.</p>
      <Segmented value={o.mode} onChange={v => setO({ mode: v })} options={[{ value: 'blur', label: 'Blur' }, { value: 'pixelate', label: 'Pixels' }, { value: 'black', label: 'Black box' }]} />
      {o.mode !== 'black' && <Slider label="Strength" value={o.strength} min={10} max={100} zero={60} onChange={v => setO({ strength: v }, false)} onCommit={() => ed.commit()} />}
      <div className="set-row"><span>Round (for faces)</span><Switch checked={o.round} onChange={v => setO({ round: v })} label="Round" /></div>
      {areas.length > 0 && <div className="tool-row">
        <span className="muted small grow">{areas.length} hidden {areas.length === 1 ? 'area' : 'areas'}</span>
        {sel && <button type="button" className="btn danger-text sm" onClick={() => ed.removeLayer(sel.id)}><Icon name="trash" size={14} />Remove this</button>}
        <button type="button" className="btn ghost sm" onClick={() => ed.commit({ ...r, layers: (r.layers || []).filter(l => l.type !== 'redact') })}>Remove all</button>
      </div>}
    </div>
  )
}

// ---- frame ----

export function FramePanel({ ed }: { ed: Ed }) {
  const r = ed.recipe
  const f: Frame = r.frame || { width: 0, color: '#ffffff', radius: 0, fit: 'none', fill: 'color', pad: 6 }
  const setF = (p: Partial<Frame>, commit = true) => { const n = { ...r, frame: { ...f, ...p } }; if (commit) ed.commit(n); else ed.set(n) }
  const presets: { label: string; f: Partial<Frame> }[] = [
    { label: 'None', f: { width: 0, radius: 0, fit: 'none' } }, { label: 'Thin white', f: { width: 2, color: '#ffffff', radius: 0, fit: 'none' } },
    { label: 'Gallery', f: { width: 8, color: '#ffffff', radius: 0, fit: 'none' } }, { label: 'Black', f: { width: 4, color: '#111111', radius: 0, fit: 'none' } },
    { label: 'Rounded', f: { width: 0, radius: 12, fit: 'none' } }, { label: 'Square post', f: { width: 0, radius: 0, fit: '1:1', fill: 'blur', pad: 4 } },
    { label: 'Story 9:16', f: { width: 0, radius: 4, fit: '9:16', fill: 'blur', pad: 6 } },
  ]
  return (
    <div className="panel-body">
      <div className="chips wrap">{presets.map(p => <button type="button" key={p.label} className="chip" onClick={() => setF(p.f)}>{p.label}</button>)}</div>
      <Group title="Border" icon="frame">
        <Slider label="Width" value={f.width} min={0} max={25} step={0.5} unit="%" onDraft={ed.setDraft} onChange={v => setF({ width: v }, false)} onCommit={() => ed.commit()} />
        <Swatches label="Colour" value={f.color} onChange={c => setF({ color: c || '#ffffff' })} />
        <Slider label="Rounded corners" value={f.radius} min={0} max={100} onDraft={ed.setDraft} onChange={v => setF({ radius: v }, false)} onCommit={() => ed.commit()} />
      </Group>
      <Group title="Fit into a shape" icon="aspect">
        <p className="muted small">Puts the whole picture on a square or story-shaped background, nothing cut off.</p>
        <div className="chips wrap">{['none', '1:1', '4:5', '9:16', '16:9', '3:2'].map(k => <button type="button" key={k} className={`chip ${f.fit === k ? 'active' : ''}`} onClick={() => setF({ fit: k })}>{k === 'none' ? 'Off' : k}</button>)}</div>
        {f.fit !== 'none' && <>
          <Segmented size="sm" value={f.fill} onChange={v => setF({ fill: v })} options={[{ value: 'blur', label: 'Blurred picture' }, { value: 'color', label: 'The border colour' }]} />
          <Slider label="Space around" value={f.pad ?? 6} min={0} max={30} zero={6} unit="%" onDraft={ed.setDraft} onChange={v => setF({ pad: v }, false)} onCommit={() => ed.commit()} />
        </>}
      </Group>
    </div>
  )
}

// ---- size ----

export function ResizePanel({ ed }: { ed: Ed }) {
  const r = ed.recipe
  const [cw, ch] = cropSize(r, ed.src.width, ed.src.height)
  const [iw, ih] = imageSize(r, ed.src.width, ed.src.height)
  const [fw, fh] = finalSize(r, ed.src.width, ed.src.height)
  const [lock, setLock] = useState(true)
  const [w, setW] = useState(String(iw))
  const [h, setH] = useState(String(ih))
  useEffect(() => { setW(String(iw)); setH(String(ih)) }, [iw, ih])
  const apply = (nw: number, nh: number) => {
    nw = Math.max(1, Math.min(20000, Math.round(nw))); nh = Math.max(1, Math.min(20000, Math.round(nh)))
    ed.commit({ ...r, resize: Math.abs(nw - cw) < 1 && Math.abs(nh - ch) < 1 ? null : { w: nw, h: nh } })
  }
  const byLong = (edge: number) => { const k = edge / Math.max(cw, ch); apply(cw * k, ch * k) }
  const mp = (fw * fh) / 1e6
  return (
    <div className="panel-body">
      <div className="size-now"><b className="tnum">{fw}×{fh}</b><span className="muted small">{mp >= 0.1 ? `${mp.toFixed(1)} megapixels` : 'pixels'}{r.frame ? ' with the frame' : ''}</span></div>
      <div className="size-row">
        <Field label="Width"><input type="number" min={1} max={20000} value={w} onChange={e => { setW(e.target.value); if (lock && Number(e.target.value)) setH(String(Math.round((Number(e.target.value) * ch) / cw))) }} /></Field>
        <button type="button" className={`btn icon-only lock ${lock ? 'active-toggle' : ''}`} aria-pressed={lock} onClick={() => setLock(l => !l)} title={lock ? 'Keeps the shape' : 'Free: may stretch'}><Icon name={lock ? 'lock' : 'link'} size={15} /></button>
        <Field label="Height"><input type="number" min={1} max={20000} value={h} onChange={e => { setH(e.target.value); if (lock && Number(e.target.value)) setW(String(Math.round((Number(e.target.value) * cw) / ch))) }} /></Field>
      </div>
      <div className="tool-row"><button type="button" className="btn primary" onClick={() => apply(Number(w) || iw, Number(h) || ih)}>Set size</button>{r.resize && <button type="button" className="btn ghost" onClick={() => ed.commit({ ...r, resize: null })}>Original size</button>}</div>
      <Group title="Quick sizes" icon="resize">
        <div className="chips wrap">{[25, 50, 75].map(p => <button type="button" key={p} className="chip" onClick={() => apply((cw * p) / 100, (ch * p) / 100)}>{p}%</button>)}</div>
        <div className="chips wrap">{[3840, 2560, 1920, 1600, 1280, 1080, 800, 512].filter(e => e !== Math.round(Math.max(cw, ch))).map(e => <button type="button" key={e} className="chip" onClick={() => byLong(e)}>{e} px</button>)}</div>
        <p className="muted small">The long side, keeping the shape. 1080 is what social apps show; 1280 suits email. Making a picture bigger than it was adds no detail.</p>
      </Group>
    </div>
  )
}

// ---- details, versions, AI description ----

export function InfoPanel({ ed, onMeta, saveVersion }: { ed: Ed; onMeta: (p: { title?: string; note?: string; favorite?: boolean }) => void; saveVersion: (name: string) => Promise<void> }) {
  const { settings } = useApp()
  const { toast } = useToast()
  const im = ed.image
  const r = ed.recipe
  const [title, setTitle] = useState(im.title)
  const [note, setNote] = useState(im.note)
  useEffect(() => { setTitle(im.title); setNote(im.note) }, [im.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const { data: versions, reload } = useAsync(() => api.get<Version[]>(`${V1}/images/${im.id}/versions`), [im.id])
  const [vname, setVname] = useState('')
  const [desc, setDesc] = useState<{ busy: boolean; title?: string; alt?: string; tags?: string[]; error?: string }>({ busy: false })
  const [reset, setReset] = useState(false)
  const [fw, fh] = finalSize(r, ed.src.width, ed.src.height)
  const done = useMemo(() => describe(r), [r])
  const describeIt = async () => {
    setDesc({ busy: true })
    const v = ed.view()
    try {
      const res = await api.post<{ ok: boolean; error?: string; title?: string; alt?: string; tags?: string[] }>(`${V1}/ai/describe`, { image: v ? dataURL(v, 768, 0.82) : '' })
      setDesc(res.ok ? { busy: false, title: res.title, alt: res.alt, tags: res.tags } : { busy: false, error: res.error })
    } catch (e) { setDesc({ busy: false, error: errMsg(e) }) }
  }
  const photosURL = settings?.photos_open_url
  const { data: aiStatus } = useAsync(() => api.get<{ ready: boolean; detail: string }>(`${V1}/ai/status`), [])
  const aiOff = !settings?.ai_photos ? 'Sending pictures to the AI is switched off (Settings → AI).' : aiStatus && !aiStatus.ready ? `No AI is set up${aiStatus.detail ? `: ${aiStatus.detail}` : ''} (Settings → AI).` : ''
  return (
    <div className="panel-body">
      <Field label="Name"><input value={title} onChange={e => setTitle(e.target.value)} onBlur={() => title.trim() && title !== im.title && onMeta({ title: title.trim() })} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} /></Field>
      <Field label="Note"><textarea rows={2} value={note} onChange={e => setNote(e.target.value)} onBlur={() => note !== im.note && onMeta({ note })} placeholder="Who, where, why…" /></Field>
      <dl className="info-dl">
        <div><dt>Original</dt><dd>{im.width}×{im.height} · {im.mime.replace('image/', '').toUpperCase()} · {fmtBytes(im.bytes)}</dd></div>
        <div><dt>Finished</dt><dd>{fw}×{fh}</dd></div>
        <div><dt>From</dt><dd>{sourceName(im.source)}{im.source === 'photos' && photosURL ? <> · <a href={photosURL} target="_blank" rel="noreferrer">open Pocket Photos</a></> : ''}{im.source_name ? <span className="muted"> · {im.source_name}</span> : ''}</dd></div>
        {im.taken_at && <div><dt>Taken</dt><dd>{fmtDateTime(im.taken_at)}</dd></div>}
        {im.camera && <div><dt>Camera</dt><dd>{im.camera}</dd></div>}
        <div><dt>Added</dt><dd>{fmtDateTime(im.created_at)}</dd></div>
        {im.exports > 0 && <div><dt>Saved</dt><dd>{im.exports} {im.exports === 1 ? 'time' : 'times'}, last {fmtDateTime(im.last_export_at)}</dd></div>}
        <div><dt>Edits</dt><dd>{done.length ? done.join(', ') : <span className="muted">none yet</span>}</dd></div>
      </dl>
      <Group title="Versions" icon="history">
        <p className="muted small">Keep the edit as it is now, to come back to it after trying something else.</p>
        <div className="ai-row"><input value={vname} onChange={e => setVname(e.target.value)} placeholder="Name (optional)" onKeyDown={e => { if (e.key === 'Enter') saveVersion(vname).then(() => { setVname(''); reload() }) }} /><button type="button" className="btn" onClick={() => saveVersion(vname).then(() => { setVname(''); reload() })}>Save version</button></div>
        <div className="versions">
          {versions?.map(v => (
            <div key={v.id} className="version">
              <button type="button" className="version-main" onClick={() => { ed.commit(v.recipe || {}); toast(`Back to “${v.name}” (undo with ⌘Z)`) }} title="Go back to this version">
                {v.has_thumb ? <img src={`${V1}/versions/${v.id}/thumb`} alt="" /> : <span className="version-ph"><Icon name="image" size={14} /></span>}
                <span className="grow" style={{ minWidth: 0 }}><span className="ellipsis block">{v.name}</span><span className="muted small">{fmtDateTime(v.created_at)}</span></span>
              </button>
              <button type="button" className="btn ghost icon-only sm" aria-label="Delete version" onClick={async () => { try { await api.del(`${V1}/versions/${v.id}`); reload() } catch (e) { toast(errMsg(e), 'err') } }}><Icon name="trash" size={14} /></button>
            </div>
          ))}
        </div>
      </Group>
      <Group title="Describe with AI" icon="sparkles" open={false}>
        <button type="button" className="btn" onClick={describeIt} disabled={desc.busy || !!aiOff} title={aiOff || undefined}>{desc.busy ? <Spinner /> : <Icon name="sparkles" size={15} />}Describe this picture</button>
        {aiOff && <p className="muted small">{aiOff}</p>}
        {desc.error && <p className="bad small">{desc.error}</p>}
        {desc.title && <div className="ai-out">
          <p><b>{desc.title}</b> <button type="button" className="link-btn small" onClick={() => { setTitle(desc.title!); onMeta({ title: desc.title }) }}>Use as name</button></p>
          {desc.alt && <p className="small">{desc.alt} <button type="button" className="link-btn small" onClick={() => copyText(desc.alt!).then(ok => toast(ok ? 'Copied' : 'Could not copy', ok ? 'ok' : 'err'))}>Copy</button></p>}
          {!!desc.tags?.length && <div className="chips wrap">{desc.tags.map(t => <span key={t} className="chip">{t}</span>)}</div>}
        </div>}
      </Group>
      <button type="button" className="btn ghost danger-text" onClick={() => setReset(true)} disabled={!Object.keys(clean(r)).some(k => k !== 'v')}><Icon name="refresh" size={15} />Start over from the original</button>
      {reset && <Confirm title="Start over?" message="Every edit is removed (undo brings them back while the editor is open). Saved versions stay." confirmLabel="Start over" onCancel={() => setReset(false)} onConfirm={() => { setReset(false); ed.commit({}) }} />}
    </div>
  )
}

// ---- local adjustments ----

export function LocalPanel({ ed }: { ed: Ed }) {
  const r = ed.recipe
  const masks = r.masks || []
  const m = masks.find(x => x.id === ed.selected) || null
  const add = (kind: Mask['kind']) => {
    const base = { id: newId(), adjust: { exposure: kind === 'linear' ? -30 : 20 } }
    const nm: Mask = kind === 'linear' ? { ...base, kind, x1: 0.5, y1: 0.05, x2: 0.5, y2: 0.55, name: 'Gradient' }
      : kind === 'radial' ? { ...base, kind, x: 0.5, y: 0.45, rx: 0.25, ry: 0.25 * (ed.base.w / Math.max(1, ed.base.h)), feather: 60, name: 'Circle' }
        : { ...base, kind, strokes: [], feather: 60, name: 'Brush' }
    ed.commit({ ...r, masks: [...masks, nm] })
    ed.select(nm.id)
  }
  const upd = (patch: Partial<Mask>, commit = true) => { if (!m) return; const n = { ...r, masks: masks.map(x => x.id === m.id ? { ...x, ...patch } as Mask : x) }; if (commit) ed.commit(n); else ed.set(n) }
  const a: Adjust = { ...ADJUST_ZERO, ...(m?.adjust || {}) }
  const label = (k: AdjustKey) => SLIDER_GROUPS.flatMap(g => g.sliders).find(x => x.key === k)!
  return (
    <div className="panel-body">
      <p className="muted small">Change only part of the picture: darken a sky with a gradient, brighten a face with a circle, or paint where.</p>
      <div className="tool-row">
        <button type="button" className="btn" onClick={() => add('linear')}><Icon name="contrast" size={15} />Gradient</button>
        <button type="button" className="btn" onClick={() => add('radial')}><Icon name="circle-o" size={15} />Circle</button>
        <button type="button" className="btn" onClick={() => add('brush')}><Icon name="brush" size={15} />Brush</button>
      </div>
      {masks.length > 0 && <div className="chips wrap">{masks.map((x, i) => <button type="button" key={x.id} className={`chip ${ed.selected === x.id ? 'active' : ''}`} onClick={() => ed.select(x.id)}>{x.name || x.kind} {i + 1}</button>)}</div>}
      {m ? <>
        <div className="set-row"><span>Show where</span><Switch checked={ed.paint.show} onChange={v => ed.setPaint({ ...ed.paint, show: v })} label="Show the area" /></div>
        {m.kind === 'brush' && <>
          <Segmented size="sm" value={ed.paint.erase ? 'erase' : 'paint'} onChange={v => ed.setPaint({ ...ed.paint, erase: v === 'erase' })} options={[{ value: 'paint', label: 'Paint' }, { value: 'erase', label: 'Erase' }]} />
          <Slider label="Brush size" value={Math.round(ed.paint.size * 100)} min={1} max={40} zero={8} unit="%" onChange={v => ed.setPaint({ ...ed.paint, size: v / 100 })} onCommit={() => {}} />
        </>}
        {m.kind !== 'linear' && <Slider label="Soft edge" value={'feather' in m ? m.feather : 50} min={2} max={100} zero={60} onDraft={ed.setDraft} onChange={v => upd({ feather: v } as Partial<Mask>, false)} onCommit={() => ed.commit()} />}
        <div className="set-row"><span>The other way round</span><Switch checked={!!m.invert} onChange={v => upd({ invert: v })} label="Invert" /></div>
        {LOCAL_SLIDERS.map(k => { const d = label(k); return <Slider key={k} label={d.label} value={a[k]} min={d.min} max={d.max} unit={d.unit} onDraft={ed.setDraft} onChange={v => upd({ adjust: { ...m.adjust, [k]: v } }, false)} onCommit={() => ed.commit()} /> })}
        <button type="button" className="btn danger-text" onClick={() => { ed.commit({ ...r, masks: masks.filter(x => x.id !== m.id) }); ed.select(null) }}><Icon name="trash" size={14} />Remove this adjustment</button>
      </> : masks.length > 0 && <p className="muted small">Pick one above to change it.</p>}
    </div>
  )
}

// ---- heal and clone ----

export function HealPanel({ ed }: { ed: Ed }) {
  const r = ed.recipe
  const heals = r.heals || []
  const sel = heals.find(h => h.id === ed.selected)
  return (
    <div className="panel-body">
      <p className="small">Tap a spot, a speck of dust or a stray hair: it is painted over from a nearby patch. Drag the dashed circle to choose where from.</p>
      <Segmented value={ed.paint.heal} onChange={v => ed.setPaint({ ...ed.paint, heal: v })} options={[{ value: 'heal', label: 'Heal (blends in)' }, { value: 'clone', label: 'Clone (exact copy)' }]} />
      <Slider label="Size" value={Math.round(ed.paint.size * 100)} min={1} max={30} zero={4} unit="%" onChange={v => { ed.setPaint({ ...ed.paint, size: v / 100 }); if (sel) ed.set({ ...r, heals: heals.map(h => h.id === sel.id ? { ...h, r: v / 200 } : h) }) }} onCommit={() => sel && ed.commit()} />
      {heals.length > 0 && <div className="tool-row">
        <span className="muted small grow">{heals.length} {heals.length === 1 ? 'spot' : 'spots'}</span>
        {sel && <button type="button" className="btn danger-text sm" onClick={() => { ed.commit({ ...r, heals: heals.filter(h => h.id !== sel.id) }); ed.select(null) }}><Icon name="trash" size={14} />Remove this</button>}
        <button type="button" className="btn ghost sm" onClick={() => ed.commit({ ...r, heals: [] })}>Remove all</button>
      </div>}
    </div>
  )
}

// ---- background ----

export function CutoutPanel({ ed }: { ed: Ed }) {
  const { toast } = useToast()
  const r = ed.recipe
  const c = r.cutout
  const [busy, setBusy] = useState('')
  const find = async () => {
    try { setBusy('Starting…'); const mask = await findSubject(ed.src, setBusy); ed.commit({ ...r, cutout: { mask, bg: null, keep: [], remove: [], feather: 20 } }); toast('Background taken away: fix the edges with the brush if needed') } catch (e) { toast(errMsg(e), 'err') } finally { setBusy('') }
  }
  const set = (p: Partial<NonNullable<typeof c>>, commit = true) => { if (!c) return; const n = { ...r, cutout: { ...c, ...p } }; if (commit) ed.commit(n); else ed.set(n) }
  return (
    <div className="panel-body">
      <p className="small">Keep the person, the pet or the thing, and take everything behind away. It runs on this device; nothing is sent anywhere.</p>
      {!c ? <button type="button" className="btn primary block-btn" onClick={find} disabled={!!busy}>{busy ? <><Spinner />{busy}</> : <><Icon name="wand" size={15} />Remove the background</>}</button> : <>
        <Group title="Fix the edges" icon="brush">
          <Segmented value={ed.paint.keep ? 'keep' : 'remove'} onChange={v => ed.setPaint({ ...ed.paint, keep: v === 'keep' })} options={[{ value: 'keep', label: 'Bring back' }, { value: 'remove', label: 'Take away' }]} />
          <Slider label="Brush size" value={Math.round(ed.paint.size * 100)} min={1} max={40} zero={8} unit="%" onChange={v => ed.setPaint({ ...ed.paint, size: v / 100 })} onCommit={() => {}} />
          <Slider label="Soft edge" value={c.feather ?? 20} min={0} max={100} zero={20} onDraft={ed.setDraft} onChange={v => set({ feather: v }, false)} onCommit={() => ed.commit()} />
          {(c.keep?.length || c.remove?.length) ? <button type="button" className="btn ghost sm" onClick={() => set({ keep: [], remove: [] })}>Undo all the brushing</button> : null}
        </Group>
        <Group title="Behind it" icon="image">
          <div className="swatches">
            <button type="button" className={`swatch none ${c.bg === null ? 'active' : ''}`} onClick={() => set({ bg: null })} title="See-through (save as PNG or WebP)" aria-label="See-through" />
            <button type="button" className={`swatch blurbg ${c.bg === 'blur' ? 'active' : ''}`} onClick={() => set({ bg: 'blur' })} title="The background, blurred" aria-label="Blurred" />
            {SWATCHES.map(col => <button type="button" key={col} className={`swatch ${c.bg === col ? 'active' : ''}`} style={{ background: col }} onClick={() => set({ bg: col })} aria-label={col} />)}
            <label className="swatch custom" title="Another colour"><input type="color" value={c.bg && c.bg.startsWith('#') ? c.bg : '#ffffff'} onChange={e => set({ bg: e.target.value }, false)} onBlur={() => ed.commit()} /><Icon name="plus" size={12} /></label>
          </div>
          {c.bg === null && <p className="muted small">Save as PNG or WebP to keep it see-through; JPEG puts white behind.</p>}
        </Group>
        <div className="tool-row">
          <button type="button" className="btn" onClick={find} disabled={!!busy}>{busy ? <><Spinner />{busy}</> : <><Icon name="refresh" size={14} />Find it again</>}</button>
          <button type="button" className="btn danger-text" onClick={() => ed.commit({ ...r, cutout: null })}><Icon name="trash" size={14} />Bring the background back</button>
        </div>
      </>}
    </div>
  )
}
