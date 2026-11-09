// The editor: one picture, every tool, undo for everything, saved as you go.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import { useApp } from '../lib/app-context'
import type { Image } from '../lib/types'
import { clean, isEdited, type Layer, type Recipe } from '../lib/recipe'
import { cropSize, dataURL, encode, finish, loadBitmap, prepareLayers, render, renderBase, type Canvas } from '../lib/render/engine'
import { originalURL, saveLook } from '../lib/images'
import { Icon } from '../components/icons'
import { AskButton } from '../components/AskButton'
import { announceChange } from '../components/Layout'
import { ExportDialog } from '../components/ExportDialog'
import { Stage } from '../components/editor/Stage'
import { AdjustPanel, ColorPanel, CropPanel, CutoutPanel, DrawPanel, EffectsPanel, FramePanel, HealPanel, HidePanel, InfoPanel, LocalPanel, LooksPanel, ResizePanel, TextPanel } from '../components/editor/Panels'
import type { Brush, DrawMode, Ed, PaintOpts, RedactOpts, Tool } from '../components/editor/types'
import { loadFonts } from '../lib/fonts'
import { Confirm, Loading, MenuButton, type MenuItem, modalOpen, useIsMobile, useToast, errMsg } from '../components/ui'

const TOOLS: { id: Tool; label: string; icon: string; key?: string }[] = [
  { id: 'crop', label: 'Crop', icon: 'crop', key: 'c' }, { id: 'adjust', label: 'Adjust', icon: 'sliders', key: 'a' }, { id: 'local', label: 'Local', icon: 'focus', key: 'm' }, { id: 'color', label: 'Colour', icon: 'palette' },
  { id: 'looks', label: 'Looks', icon: 'wand', key: 'l' }, { id: 'effects', label: 'Effects', icon: 'sparkles' }, { id: 'heal', label: 'Heal', icon: 'eraser', key: 'j' }, { id: 'cutout', label: 'Background', icon: 'image', key: 'b' }, { id: 'text', label: 'Text', icon: 'type', key: 't' },
  { id: 'draw', label: 'Draw', icon: 'brush', key: 'd' }, { id: 'hide', label: 'Hide', icon: 'eye-slash', key: 'h' }, { id: 'frame', label: 'Frame', icon: 'frame', key: 'f' },
  { id: 'resize', label: 'Size', icon: 'resize', key: 's' }, { id: 'info', label: 'Info', icon: 'info', key: 'i' },
]
const TOOL_HELP: Partial<Record<Tool, string>> = { local: 'Local adjustments', heal: 'Heal and clone spots', cutout: 'Remove the background', crop: 'Crop and turn', adjust: 'Light and colour', color: 'Curves, colour mixer, split toning', looks: 'Looks (filters)', effects: 'Effects', text: 'Text, stickers, watermark', draw: 'Draw and shapes', hide: 'Hide faces and plates', frame: 'Frame and background', resize: 'Size', info: 'Details and versions' }

const same = (a: Recipe, b: Recipe) => JSON.stringify(clean(a)) === JSON.stringify(clean(b))
const noPixelsPart = (r: Recipe): Recipe => ({ rotate: r.rotate, flipH: r.flipH, flipV: r.flipV, straighten: r.straighten, perspective: r.perspective, crop: r.crop, resize: r.resize })

export default function Editor() {
  const { id } = useParams()
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const { settings } = useApp()
  const { toast } = useToast()
  const mobile = useIsMobile()
  const [image, setImage] = useState<Image | null>(null)
  const [src, setSrc] = useState<ImageBitmap | null>(null)
  const [error, setError] = useState('')
  const [recipe, setRecipeState] = useState<Recipe>({})
  const rec = useRef<Recipe>({})
  const committed = useRef<Recipe>({})
  const past = useRef<Recipe[]>([])
  const future = useRef<Recipe[]>([])
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const [tool, setToolState] = useState<Tool>(() => (TOOLS.find(t => t.id === sp.get('tool'))?.id) || 'adjust')
  const toolRef = useRef(tool)
  const [selected, setSelected] = useState<string | null>(null)
  const [drawMode, setDrawMode] = useState<DrawMode>('brush')
  const [brush, setBrush] = useState<Brush>({ color: '#f03e3e', width: 6, opacity: 1, fill: null })
  const [redact, setRedact] = useState<RedactOpts>({ mode: 'blur', strength: 60, round: false })
  const [paint, setPaint] = useState<PaintOpts>({ size: 0.06, erase: false, show: true, heal: 'heal', keep: true })
  const [comparing, setComparing] = useState(false)
  const [split, setSplit] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [del, setDel] = useState(false)
  const previewSize = settings?.preview_size || 2048

  // ---- load ----
  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    setImage(null); setSrc(null); setError('')
    api.get<{ image: Image }>(`${V1}/images/${id}`).then(async ({ image }) => {
      if (!alive) return
      setImage(image)
      const r = image.recipe || {}
      rec.current = r; committed.current = r; past.current = []; future.current = []
      setRecipeState(r)
      try { const bmp = await loadBitmap(originalURL(image), ac.signal); if (alive) setSrc(bmp); else bmp.close() } catch (e) {
        if (alive) setError(image.mime === 'image/heic' ? 'This browser cannot open HEIC pictures. Open the lab in Safari, or bring the picture in from Pocket Photos (it sends a JPEG).' : errMsg(e))
      }
    }).catch(e => alive && setError(errMsg(e)))
    return () => { alive = false; ac.abort() }
  }, [id])
  useEffect(() => () => { src?.close() }, [src])

  // ---- rendering: geometry + pixels (cached), then text and frame ----
  const draft = useRef(false)
  const [view, setView] = useState<{ canvas: Canvas | null; version: number; base: { w: number; h: number } }>({ canvas: null, version: 0, base: { w: 0, h: 0 } })
  const baseCache = useRef<{ key: string; canvas: Canvas } | null>(null)
  const req = useRef(0)
  const busy = useRef(false)
  const ver = useRef(0)
  const runRender = useCallback(async () => {
    if (!src || busy.current) return
    busy.current = true
    try {
      for (;;) {
        const my = req.current
        const r = rec.current
        const crop = toolRef.current === 'crop'
        const maxEdge = draft.current ? Math.min(1000, previewSize) : previewSize
        const layers = (r.layers || []).filter(l => l.type === 'redact' && !(draft.current && toolRef.current === 'hide'))
        const baseRecipe: Recipe = { ...r, layers: crop ? [] : layers, masks: crop ? [] : r.masks, heals: crop ? [] : r.heals }
        const key = JSON.stringify([crop, maxEdge, crop ? null : r.crop, r.rotate, r.flipH, r.flipV, r.straighten, r.perspective, crop ? null : r.resize, r.adjust, r.curves, r.hsl, r.split, r.look, r.effects, baseRecipe.layers, baseRecipe.masks, baseRecipe.heals, r.cutout])
        let base = baseCache.current?.key === key ? baseCache.current.canvas : null
        if (!base) { base = await renderBase(src, src.width, src.height, baseRecipe, { maxEdge, uncropped: crop }); baseCache.current = { key, canvas: base } }
        if (my !== req.current) continue
        await prepareLayers(rec.current)
        const out = crop ? base : finish(base, rec.current, { transparent: true })
        setView({ canvas: out, version: ++ver.current, base: { w: base.width, h: base.height } })
        if (my === req.current) break
      }
    } catch (e) { toast(errMsg(e), 'err') } finally { busy.current = false }
  }, [src, previewSize, toast])
  const schedule = useCallback(() => { req.current++; requestAnimationFrame(() => { runRender() }) }, [runRender])
  useEffect(() => { if (src) loadFonts().finally(() => { req.current++; runRender() }) }, [src, runRender])

  // the original, for comparing (same crop and size)
  const [before, setBefore] = useState<Canvas | null>(null)
  const beforeKey = useRef('')
  useEffect(() => {
    if (!src || (!comparing && !split) || tool === 'crop') return
    const r = noPixelsPart(rec.current)
    const key = JSON.stringify([r, previewSize])
    if (key === beforeKey.current && before) return
    beforeKey.current = key
    renderBase(src, src.width, src.height, r, { maxEdge: previewSize, noPixels: true }).then(c => { c.style.width = '100%'; c.style.height = '100%'; setBefore(c) })
  }, [src, comparing, split, recipe, previewSize, tool]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- saving as you go: the edit, then the rendered look ----
  const [saveState, setSaveState] = useState<'saved' | 'waiting' | 'saving' | 'error'>('saved')
  const dirty = useRef(false)
  const saving = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const flush = useCallback(async () => {
    window.clearTimeout(timer.current)
    if (!dirty.current || saving.current || !image) return
    dirty.current = false; saving.current = true; setSaveState('saving')
    const r = clean(committed.current)
    try {
      const res = await api.put<{ image: Image }>(`${V1}/images/${image.id}`, { recipe: r, edited: isEdited(r) })
      if (src && isEdited(r)) await saveLook(image.id, await encode(await render(src, src.width, src.height, r, { maxEdge: 2048 }), 'jpeg', 0.88))
      else await fetch(`${V1}/images/${image.id}/look?reset=1`, { method: 'PUT', credentials: 'same-origin' })
      setImage(im => im ? { ...im, ...res.image, recipe: im.recipe } : im)
      announceChange()
      setSaveState(dirty.current ? 'waiting' : 'saved')
    } catch (e) { dirty.current = true; setSaveState('error'); toast(`Not saved: ${errMsg(e)}`, 'err') } finally {
      saving.current = false
      if (dirty.current) timer.current = window.setTimeout(() => flush(), 2500)
    }
  }, [image, src, toast])
  const flushRef = useRef(flush)
  flushRef.current = flush
  const queueSave = useCallback(() => { dirty.current = true; setSaveState('waiting'); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => flushRef.current(), 1400) }, [])
  useEffect(() => () => { if (dirty.current) flushRef.current() }, [])
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty.current || saving.current) { flushRef.current(); e.preventDefault() } }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [])

  // ---- the edit, undo and redo ----
  const keepShape = useCallback((prev: Recipe, r: Recipe): Recipe => {
    if (!src || !r.resize || (JSON.stringify(prev.crop) === JSON.stringify(r.crop) && prev.rotate === r.rotate)) return r
    const [cw, ch] = cropSize(r, src.width, src.height)
    return { ...r, resize: { w: r.resize.w, h: Math.max(1, Math.round((r.resize.w * ch) / cw)) } }
  }, [src])
  const set = useCallback((r: Recipe) => { r = keepShape(rec.current, r); rec.current = r; setRecipeState(r); schedule() }, [schedule, keepShape])
  const commit = useCallback((r?: Recipe) => {
    if (r) set(r)
    if (same(rec.current, committed.current)) return
    past.current.push(committed.current)
    if (past.current.length > 200) past.current.shift()
    future.current = []
    committed.current = rec.current
    bump(); queueSave()
  }, [set, queueSave])
  const undo = useCallback(() => {
    if (!same(rec.current, committed.current)) { set(committed.current); return }
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(committed.current)
    committed.current = prev
    set(prev); bump(); queueSave()
  }, [set, queueSave])
  const redo = useCallback(() => {
    const nx = future.current.pop()
    if (!nx) return
    past.current.push(committed.current)
    committed.current = nx
    set(nx); bump(); queueSave()
  }, [set, queueSave])
  const setDraft = useCallback((on: boolean) => { if (draft.current === on) return; draft.current = on; if (!on) schedule() }, [schedule])
  const setTool = useCallback((t: Tool) => { toolRef.current = t; setToolState(t); setSelected(null); schedule() }, [schedule])

  const ed: Ed | null = useMemo(() => image && src ? {
    image, src, recipe, set, commit, setDraft, tool, setTool, selected, select: setSelected, drawMode, setDrawMode, brush, setBrush, redact, setRedact, paint, setPaint,
    base: view.base, view: () => view.canvas,
    updateLayer: (lid: string, patch: Partial<Layer>, c = true) => { const r = { ...rec.current, layers: (rec.current.layers || []).map(l => l.id === lid ? { ...l, ...patch } as Layer : l) }; if (c) commit(r); else set(r) },
    addLayer: (l: Layer) => { commit({ ...rec.current, layers: [...(rec.current.layers || []), l] }); setSelected(l.id) },
    removeLayer: (lid: string) => { commit({ ...rec.current, layers: (rec.current.layers || []).filter(l => l.id !== lid) }); setSelected(null) },
  } : null, [image, src, recipe, set, commit, setDraft, tool, setTool, selected, drawMode, brush, redact, paint, view])

  const saveVersion = async (name: string) => {
    if (!image) return
    try { await flush(); await api.post(`${V1}/images/${image.id}/versions`, { name: name.trim(), recipe: clean(committed.current), thumb: view.canvas ? dataURL(view.canvas, 200) : '' }); toast('Version saved'); setImage(im => im ? { ...im, versions: im.versions + 1 } : im) } catch (e) { toast(errMsg(e), 'err') }
  }
  const onMeta = async (p: { title?: string; note?: string; favorite?: boolean }) => {
    if (!image) return
    try { const r = await api.put<{ image: Image }>(`${V1}/images/${image.id}`, p); setImage(im => im ? { ...im, ...r.image, recipe: im.recipe } : im); announceChange() } catch (e) { toast(errMsg(e), 'err') }
  }
  const leave = () => { flush(); navigate('/') }
  const copy = async (fresh: boolean) => {
    if (!image) return
    await flush()
    try { const r = await api.post<{ image: Image }>(`${V1}/images/${image.id}/copy`, { fresh }); announceChange(); navigate(`/edit/${r.image.id}`); toast(fresh ? 'A fresh copy of the original' : 'A copy to try something else') } catch (e) { toast(errMsg(e), 'err') }
  }

  // ---- keyboard ----
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = t.closest('input, textarea, select, [contenteditable="true"]')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); setExporting(true); return }
      if (e.metaKey || e.ctrlKey || e.altKey || typing || modalOpen() || document.querySelector('.menu, .popover, .sel-pop')) return
      if (e.key === '\\') { e.preventDefault(); setComparing(true); return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && ed) {
        e.preventDefault()
        const r = rec.current
        if ((r.masks || []).some(m => m.id === selected)) ed.commit({ ...r, masks: r.masks!.filter(m => m.id !== selected) })
        else if ((r.heals || []).some(h => h.id === selected)) ed.commit({ ...r, heals: r.heals!.filter(h => h.id !== selected) })
        else ed.removeLayer(selected)
        setSelected(null)
        return
      }
      if (selected && ed && e.key.startsWith('Arrow') && (rec.current.layers || []).some(l => l.id === selected)) {
        // nudge the selected text, shape or picture: 1 px of the view (10 with shift)
        e.preventDefault()
        const k = (e.shiftKey ? 10 : 1) / Math.max(1, Math.min(view.base.w, view.base.h))
        const dx = e.key === 'ArrowLeft' ? -k : e.key === 'ArrowRight' ? k : 0, dy = e.key === 'ArrowUp' ? -k : e.key === 'ArrowDown' ? k : 0
        const l = rec.current.layers!.find(x => x.id === selected)!
        const moved = 'x1' in l ? { ...l, x1: l.x1 + dx, y1: l.y1 + dy, x2: l.x2 + dx, y2: l.y2 + dy } : 'points' in l ? { ...l, points: l.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) } : 'x' in l ? { ...l, x: l.x + dx, y: l.y + dy } : l
        ed.updateLayer(selected, moved as Layer, true)
        return
      }
      if (e.key === 'Escape') { if (selected) setSelected(null); else if (toolRef.current === 'crop') setTool('adjust'); else leave(); return }
      if (e.key === '0') { window.dispatchEvent(new CustomEvent('plab:zoom', { detail: 'fit' })); return }
      if (e.key === '+' || e.key === '=') { window.dispatchEvent(new CustomEvent('plab:zoom', { detail: 'in' })); return }
      if (e.key === '-') { window.dispatchEvent(new CustomEvent('plab:zoom', { detail: 'out' })); return }
      if (e.key === 'e') { e.preventDefault(); setExporting(true); return }
      const tl = TOOLS.find(x => x.key === e.key)
      if (tl) { e.preventDefault(); setTool(tl.id) }
    }
    const up = (e: KeyboardEvent) => { if (e.key === '\\') setComparing(false) }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  })

  if (error) return <div className="editor"><header className="ed-top"><button type="button" className="btn ghost icon-only" onClick={() => navigate('/')} aria-label="Back"><Icon name="chevron-left" size={18} /></button><h1 className="ed-title">{image?.title || 'Picture'}</h1><span className="spacer" /><AskButton /></header><div className="ed-error"><div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div></div></div>
  if (!image || !src || !ed) return <div className="editor"><header className="ed-top"><button type="button" className="btn ghost icon-only" onClick={() => navigate('/')} aria-label="Back"><Icon name="chevron-left" size={18} /></button><h1 className="ed-title">{image?.title || ''}</h1><span className="spacer" /><AskButton /></header><Loading label="Opening the picture…" /></div>

  const more: MenuItem[] = [
    { label: image.favorite ? 'Not a favourite' : 'Favourite', icon: 'star', onSelect: () => onMeta({ favorite: !image.favorite }) },
    { label: split ? 'Hide the before / after line' : 'Before / after side by side', icon: 'compare', onSelect: () => setSplit(s => !s) },
    'sep',
    { label: 'Make a copy to try something else', icon: 'copy', onSelect: () => copy(false) },
    { label: 'Start again from the original (as a copy)', icon: 'refresh', onSelect: () => copy(true) },
    { label: 'Download the original', icon: 'download', onSelect: () => { window.location.href = `${originalURL(image)}&download=1` } },
    'sep',
    { label: 'Remove from the lab', icon: 'trash', danger: true, onSelect: () => setDel(true) },
  ]
  const status = saveState === 'saving' ? 'Saving…' : saveState === 'waiting' ? 'Changes…' : saveState === 'error' ? 'Not saved' : 'Saved'
  const panel = (() => {
    switch (tool) {
      case 'crop': return <CropPanel ed={ed} />
      case 'adjust': return <AdjustPanel ed={ed} histo={{ canvas: view.canvas, version: view.version }} />
      case 'local': return <LocalPanel ed={ed} />
      case 'heal': return <HealPanel ed={ed} />
      case 'cutout': return <CutoutPanel ed={ed} />
      case 'color': return <ColorPanel ed={ed} />
      case 'looks': return <LooksPanel ed={ed} />
      case 'effects': return <EffectsPanel ed={ed} />
      case 'text': return <TextPanel ed={ed} />
      case 'draw': return <DrawPanel ed={ed} />
      case 'hide': return <HidePanel ed={ed} />
      case 'frame': return <FramePanel ed={ed} />
      case 'resize': return <ResizePanel ed={ed} />
      case 'info': return <InfoPanel ed={ed} onMeta={onMeta} saveVersion={saveVersion} />
    }
  })()
  return (
    <div className={`editor ${mobile ? 'is-mobile' : ''}`}>
      <header className="ed-top">
        <button type="button" className="btn ghost icon-only" onClick={leave} aria-label="Back to your pictures" title="Back (esc)"><Icon name="chevron-left" size={18} /></button>
        <div className="ed-title-wrap">
          <h1 className="ed-title ellipsis" title={image.title}>{image.title}</h1>
          <span className={`ed-status small ${saveState === 'error' ? 'bad' : 'muted'}`} aria-live="polite">{saveState === 'error' ? <button type="button" className="link-btn bad" onClick={() => { dirty.current = true; flush() }}>Not saved, retry</button> : status}</span>
        </div>
        <span className="spacer" />
        <button type="button" className="btn ghost icon-only" onClick={undo} disabled={!past.current.length && same(recipe, committed.current)} aria-label="Undo" title="Undo (⌘Z)"><Icon name="undo" size={18} /></button>
        <button type="button" className="btn ghost icon-only" onClick={redo} disabled={!future.current.length} aria-label="Redo" title="Redo (⇧⌘Z)"><Icon name="redo" size={18} /></button>
        <button type="button" className={`btn ghost icon-only ${comparing ? 'active-toggle' : ''}`} aria-label="Hold to see the original" title="Hold to see the original (\)"
          onPointerDown={e => { (e.currentTarget as Element).setPointerCapture(e.pointerId); setComparing(true) }} onPointerUp={() => setComparing(false)} onPointerCancel={() => setComparing(false)} onContextMenu={e => e.preventDefault()}><Icon name="eye" size={18} /></button>
        <AskButton />
        <MenuButton label="More" className="btn ghost icon-only" align="right" width={290} items={more}><Icon name="more" size={18} /></MenuButton>
        <button type="button" className="btn primary" onClick={() => setExporting(true)} title="Save a copy (E)"><Icon name="download" size={15} />{mobile ? 'Save' : 'Save a copy'}</button>
      </header>
      <div className="ed-body">
        <div className="ed-stage-wrap">
          <Stage ed={ed} canvas={view.canvas} version={view.version} before={before} comparing={comparing} split={split && tool !== 'crop'} showGrid={settings?.show_grid !== false} />
          {!mobile && <div className="ed-zoom">
            <button type="button" className="btn ghost icon-only sm" onClick={() => window.dispatchEvent(new CustomEvent('plab:zoom', { detail: 'out' }))} aria-label="Zoom out" title="Zoom out (−)"><Icon name="zoom-out" size={16} /></button>
            <button type="button" className="btn ghost sm" onClick={() => window.dispatchEvent(new CustomEvent('plab:zoom', { detail: 'fit' }))} title="Fit (0)">Fit</button>
            <button type="button" className="btn ghost icon-only sm" onClick={() => window.dispatchEvent(new CustomEvent('plab:zoom', { detail: 'in' }))} aria-label="Zoom in" title="Zoom in (+)"><Icon name="zoom-in" size={16} /></button>
          </div>}
        </div>
        <aside className="ed-side">
          <nav className="ed-tools" aria-label="Tools">
            {TOOLS.map(t => <button type="button" key={t.id} className={`ed-tool ${tool === t.id ? 'active' : ''}`} aria-pressed={tool === t.id} onClick={() => setTool(t.id)} title={`${TOOL_HELP[t.id] || t.label}${t.key ? ` (${t.key.toUpperCase()})` : ''}`}><Icon name={t.icon} size={18} /><span>{t.label}</span></button>)}
          </nav>
          <div className="ed-panel">
            {!mobile && <h2 className="ed-panel-title">{TOOL_HELP[tool] || tool}</h2>}
            {panel}
          </div>
        </aside>
      </div>
      {exporting && <ExportDialog image={image} recipe={clean(committed.current)} src={src} onClose={() => setExporting(false)} onSaved={() => { flush(); announceChange() }} />}
      {del && <Confirm title={`Remove “${image.title}”?`} message="The picture leaves the lab with its edits and saved versions. Anything in Pocket Photos or Pocket Files stays where it is." confirmLabel="Remove" onCancel={() => setDel(false)}
        onConfirm={async () => { setDel(false); dirty.current = false; try { await api.del(`${V1}/images/${image.id}`); announceChange(); navigate('/') } catch (e) { toast(errMsg(e), 'err') } }} />}
    </div>
  )
}
