// The picture in the middle: zoom and move it, crop it, drag text, shapes
// and drawings around, draw on it, and hide parts of it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ASPECTS, newId, type BrushMask, type BrushStroke, type Crop, type DrawLayer, type Heal, type Layer, type LinearMask, type Mask, type Pt, type RadialMask, type TextLayer } from '../../lib/recipe'
import { bestSource, maskPlane } from '../../lib/render/pixels'
import { frameBox, textBox } from '../../lib/render/engine'
import type { Ed } from './types'

const measureCtx = (() => { let c: CanvasRenderingContext2D | null = null; return () => (c ||= document.createElement('canvas').getContext('2d')!) })()
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v))

/** A layer's box (fractions of the picture) for hit tests and handles. */
export function layerBox(l: Layer, W: number, H: number): { x: number; y: number; w: number; h: number; rot: number } | null {
  switch (l.type) {
    case 'text': { const b = textBox(measureCtx(), l, W, H); const p = b.size * 0.3; return { x: l.x - (b.w / 2 + p) / W, y: l.y - (b.h / 2 + p * 0.6) / H, w: (b.w + 2 * p) / W, h: (b.h + p * 1.2) / H, rot: l.rotate || 0 } }
    case 'sticker': { const s = l.size * Math.min(W, H); return { x: l.x - s / 2 / W, y: l.y - s / 2 / H, w: s / W, h: s / H, rot: l.rotate || 0 } }
    case 'image': { const w = l.w, h = (l.w * W * (l.aspect || 1)) / H; return { x: l.x - w / 2, y: l.y - h / 2, w, h, rot: l.rotate || 0 } }
    case 'rect': case 'ellipse': case 'redact': return { x: Math.min(l.x, l.x + l.w), y: Math.min(l.y, l.y + l.h), w: Math.abs(l.w), h: Math.abs(l.h), rot: 0 }
    case 'line': case 'arrow': { const pad = Math.max(l.width * Math.min(W, H) * 2, 8) ; return { x: Math.min(l.x1, l.x2) - pad / W, y: Math.min(l.y1, l.y2) - pad / H, w: Math.abs(l.x2 - l.x1) + 2 * pad / W, h: Math.abs(l.y2 - l.y1) + 2 * pad / H, rot: 0 } }
    case 'draw': { if (!l.points.length) return null; const xs = l.points.map(p => p[0]), ys = l.points.map(p => p[1]); const pad = l.width * Math.min(W, H) / 2; return { x: Math.min(...xs) - pad / W, y: Math.min(...ys) - pad / H, w: Math.max(...xs) - Math.min(...xs) + 2 * pad / W, h: Math.max(...ys) - Math.min(...ys) + 2 * pad / H, rot: 0 } }
  }
  return null
}

const TOOL_LAYERS: Record<string, Layer['type'][]> = { text: ['text', 'sticker', 'image'], draw: ['draw', 'rect', 'ellipse', 'line', 'arrow', 'sticker', 'image'], hide: ['redact'] }

export function Stage({ ed, canvas, version, before, comparing, split, showGrid }: { ed: Ed; canvas: HTMLCanvasElement | null; version: number; before: HTMLCanvasElement | null; comparing: boolean; split: boolean; showGrid: boolean }) {
  const stage = useRef<HTMLDivElement>(null)
  const holder = useRef<HTMLDivElement>(null)
  const beforeHolder = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [splitAt, setSplitAt] = useState(0.5)
  const crop = ed.tool === 'crop'
  const cw = canvas?.width || 0, ch = canvas?.height || 0

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const m = () => { const r = el.getBoundingClientRect(); setSize({ w: r.width, h: r.height }) }
    m(); const ro = new ResizeObserver(m); ro.observe(el); return () => ro.disconnect()
  }, [])
  useEffect(() => { if (canvas && holder.current && holder.current.firstChild !== canvas) holder.current.replaceChildren(canvas) }, [canvas, version])
  useEffect(() => { if (before && beforeHolder.current && beforeHolder.current.firstChild !== before) beforeHolder.current.replaceChildren(before) }, [before])
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [crop, ed.image.id])
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent<string>).detail; if (d === 'fit') { setZoom(1); setPan({ x: 0, y: 0 }) } else if (d === 'in') setZoom(z => Math.min(8, z * 1.25)); else if (d === 'out') setZoom(z => Math.max(0.25, z / 1.25)) }
    window.addEventListener('plab:zoom', h); return () => window.removeEventListener('plab:zoom', h)
  })

  const pad = size.w < 600 ? 12 : 28
  const fitScale = cw && ch && size.w ? Math.min((size.w - 2 * pad) / cw, (size.h - 2 * pad) / ch) : 0
  const dw = cw * fitScale * zoom, dh = ch * fitScale * zoom
  const left = (size.w - dw) / 2 + pan.x, top = (size.h - dh) / 2 + pan.y

  // where the picture itself is inside what is shown (the frame goes around it)
  const box = useMemo(() => {
    if (crop || !ed.recipe.frame || !ed.base.w) return { x: 0, y: 0, w: 1, h: 1 }
    const f = frameBox(ed.recipe.frame, ed.base.w, ed.base.h)
    return { x: f.x / f.W, y: f.y / f.H, w: ed.base.w / f.W, h: ed.base.h / f.H }
  }, [crop, ed.recipe.frame, ed.base.w, ed.base.h])
  const imgEl = useRef<HTMLDivElement>(null)
  const norm = (e: { clientX: number; clientY: number }): Pt => { const r = imgEl.current!.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] }

  // ---- zoom and move: wheel, pinch, drag the empty area ----
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ d: number; z: number; cx: number; cy: number; px: number; py: number } | null>(null)
  const panDrag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const zoomAt = useCallback((nz: number, cx: number, cy: number) => {
    nz = Math.max(0.25, Math.min(8, nz))
    setPan(p => { const k = nz / zoom; const ox = cx - size.w / 2, oy = cy - size.h / 2; return { x: ox - (ox - p.x) * k, y: oy - (oy - p.y) * k } })
    setZoom(nz)
  }, [zoom, size.w, size.h])
  const onWheel = (e: React.WheelEvent) => {
    const r = stage.current!.getBoundingClientRect()
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 0) zoomAt(zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top)
  }
  const stageDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const r = stage.current!.getBoundingClientRect()
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top, px: pan.x, py: pan.y }
      act.current = null
      return
    }
    if (e.target === stage.current || e.button === 1 || (zoom > 1 && !TOOL_LAYERS[ed.tool] && !crop)) {
      panDrag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
      stage.current!.setPointerCapture(e.pointerId)
      if (e.target === stage.current && TOOL_LAYERS[ed.tool]) ed.select(null)
    }
  }
  const stageMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const r = stage.current!.getBoundingClientRect()
      const nz = Math.max(0.25, Math.min(8, pinch.current.z * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.current.d)))
      const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top
      const k = nz / pinch.current.z
      const ox = pinch.current.cx - size.w / 2, oy = pinch.current.cy - size.h / 2
      setZoom(nz); setPan({ x: ox - (ox - pinch.current.px) * k + (cx - pinch.current.cx), y: oy - (oy - pinch.current.py) * k + (cy - pinch.current.cy) })
      return
    }
    if (panDrag.current) setPan({ x: panDrag.current.px + e.clientX - panDrag.current.x, y: panDrag.current.py + e.clientY - panDrag.current.y })
  }
  const stageUp = (e: React.PointerEvent) => { pointers.current.delete(e.pointerId); if (pointers.current.size < 2) pinch.current = null; panDrag.current = null }

  // ---- the crop box ----
  const c: Crop = ed.recipe.crop || { x: 0, y: 0, w: 1, h: 1 }
  const ratioOf = (aspect?: string): number | null => {
    if (!aspect || aspect === 'free') return null
    if (aspect === 'original') return ed.src.width / ed.src.height * (((ed.recipe.rotate || 0) / 90) % 2 ? (ed.src.height / ed.src.width) ** 2 : 1)
    return ASPECTS.find(a => a.id === aspect)?.ratio || null
  }
  const FW = ed.base.w || 1, FH = ed.base.h || 1
  const act = useRef<null | { kind: string; start: Pt; c0: Crop; layer?: Layer; id?: string }>(null)
  const cropDown = (kind: string) => (e: React.PointerEvent) => {
    e.stopPropagation()
    if (pointers.current.size >= 1 && e.pointerType === 'touch') { pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); return }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    act.current = { kind, start: norm(e), c0: { ...c } }
  }
  const cropMove = (e: React.PointerEvent) => {
    const a = act.current
    if (!a || a.layer) return
    const [u, v] = norm(e)
    const du = u - a.start[0], dv = v - a.start[1]
    const c0 = a.c0
    let { x, y, w, h } = c0
    if (a.kind === 'move') { x = clamp(c0.x + du, 0, 1 - c0.w); y = clamp(c0.y + dv, 0, 1 - c0.h) } else {
      const k = a.kind
      if (k.includes('w')) { x = clamp(c0.x + du, 0, c0.x + c0.w - 0.04); w = c0.x + c0.w - x }
      if (k.includes('e')) w = clamp(c0.w + du, 0.04, 1 - c0.x)
      if (k.includes('n')) { y = clamp(c0.y + dv, 0, c0.y + c0.h - 0.04); h = c0.y + c0.h - y }
      if (k.includes('s')) h = clamp(c0.h + dv, 0.04, 1 - c0.y)
      const ratio = ratioOf(c0.aspect)
      if (ratio) {
        // keep the shape: width × FW / (height × FH) = ratio
        if (k === 'n' || k === 's') { w = (h * FH * ratio) / FW } else { h = (w * FW) / (ratio * FH) }
        if (h > 1) { h = 1; w = (h * FH * ratio) / FW }
        if (w > 1) { w = 1; h = (w * FW) / (ratio * FH) }
        if (k.includes('n')) y = c0.y + c0.h - h
        if (k.includes('w')) x = c0.x + c0.w - w
        if (k === 'n' || k === 's') x = c0.x + (c0.w - w) / 2
        if (k === 'e' || k === 'w') y = c0.y + (c0.h - h) / 2
        x = clamp(x, 0, 1 - w); y = clamp(y, 0, 1 - h)
      }
    }
    ed.set({ ...ed.recipe, crop: { ...c0, x, y, w, h } })
  }
  const cropUp = () => { if (act.current && !act.current.layer) { act.current = null; ed.commit() } }

  // ---- layers: select, move, resize, draw new ones ----
  const kinds = TOOL_LAYERS[ed.tool]
  const layers = (ed.recipe.layers || []).filter(l => kinds?.includes(l.type) && !l.hidden)
  const W = ed.base.w || 1, H = ed.base.h || 1
  const layerDown = (l: Layer, kind: string) => (e: React.PointerEvent) => {
    if (ed.tool === 'draw' && ed.drawMode !== 'select' && kind === 'move' && l.type !== 'sticker') return
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    ed.select(l.id)
    if (l.type === 'redact') ed.setDraft(true)
    act.current = { kind, start: norm(e), c0: c, layer: JSON.parse(JSON.stringify(l)), id: l.id }
  }
  const newDown = (e: React.PointerEvent) => {
    if (!kinds || e.button === 1) return
    if (e.pointerType === 'touch' && pointers.current.size >= 1) return
    const p = norm(e)
    if (ed.tool === 'text') { ed.select(null); return }
    if (ed.tool === 'draw' && ed.drawMode === 'select') { ed.select(null); return }
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const id = newId()
    const b = ed.brush
    const U = Math.min(W, H)
    let l: Layer
    if (ed.tool === 'hide') ed.setDraft(true)
    if (ed.tool === 'hide') l = { id, type: 'redact', x: p[0], y: p[1], w: 0, h: 0, mode: ed.redact.mode, strength: ed.redact.strength, round: ed.redact.round }
    else if (ed.drawMode === 'brush' || ed.drawMode === 'marker') l = { id, type: 'draw', points: [p], stroke: b.color, width: (ed.drawMode === 'marker' ? b.width * 3 : b.width) / U, opacity: b.opacity, marker: ed.drawMode === 'marker' }
    else if (ed.drawMode === 'line' || ed.drawMode === 'arrow') l = { id, type: ed.drawMode, x1: p[0], y1: p[1], x2: p[0], y2: p[1], stroke: b.color, width: b.width / U, opacity: b.opacity }
    else l = { id, type: ed.drawMode as 'rect' | 'ellipse', x: p[0], y: p[1], w: 0, h: 0, stroke: b.color, fill: b.fill, width: b.width / U, opacity: b.opacity }
    ed.set({ ...ed.recipe, layers: [...(ed.recipe.layers || []), l] })
    act.current = { kind: 'new', start: p, c0: c, layer: l, id }
  }
  const layerMove = (e: React.PointerEvent) => {
    const a = act.current
    if (!a || !a.layer) return
    const p = norm(e)
    const du = p[0] - a.start[0], dv = p[1] - a.start[1]
    const l0 = a.layer
    let next: Layer = l0
    if (a.kind === 'new') {
      if (l0.type === 'draw') {
        const cur = (ed.recipe.layers || []).find(x => x.id === a.id) as DrawLayer | undefined
        const pts = cur ? cur.points : l0.points
        const last = pts[pts.length - 1]
        if (Math.hypot((p[0] - last[0]) * W, (p[1] - last[1]) * H) < 2) return
        next = { ...l0, points: [...pts, [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]] }
      } else if (l0.type === 'line' || l0.type === 'arrow') next = { ...l0, x2: p[0], y2: p[1] }
      else if (l0.type === 'rect' || l0.type === 'ellipse' || l0.type === 'redact') next = { ...l0, x: Math.min(a.start[0], p[0]), y: Math.min(a.start[1], p[1]), w: Math.abs(du), h: Math.abs(dv) }
    } else if (a.kind === 'move') {
      switch (l0.type) {
        case 'text': case 'sticker': case 'image': next = { ...l0, x: l0.x + du, y: l0.y + dv }; break
        case 'rect': case 'ellipse': case 'redact': next = { ...l0, x: l0.x + du, y: l0.y + dv }; break
        case 'line': case 'arrow': next = { ...l0, x1: l0.x1 + du, y1: l0.y1 + dv, x2: l0.x2 + du, y2: l0.y2 + dv }; break
        case 'draw': next = { ...l0, points: l0.points.map(([x, y]) => [x + du, y + dv] as Pt) }; break
      }
    } else if (a.kind === 'p1' && (l0.type === 'line' || l0.type === 'arrow')) next = { ...l0, x1: p[0], y1: p[1] }
    else if (a.kind === 'p2' && (l0.type === 'line' || l0.type === 'arrow')) next = { ...l0, x2: p[0], y2: p[1] }
    else if (a.kind === 'scale' && (l0.type === 'text' || l0.type === 'sticker' || l0.type === 'image')) {
      const d0 = Math.hypot((a.start[0] - l0.x) * W, (a.start[1] - l0.y) * H), d1 = Math.hypot((p[0] - l0.x) * W, (p[1] - l0.y) * H)
      const k = d1 / Math.max(4, d0)
      next = l0.type === 'image' ? { ...l0, w: clamp(l0.w * k, 0.02, 3) } : { ...l0, size: clamp(l0.size * k, 0.01, 1.5) }
    } else if (l0.type === 'rect' || l0.type === 'ellipse' || l0.type === 'redact') {
      let { x, y, w, h } = l0
      const k = a.kind
      if (k.includes('w')) { x = l0.x + du; w = l0.w - du }
      if (k.includes('e')) w = l0.w + du
      if (k.includes('n')) { y = l0.y + dv; h = l0.h - dv }
      if (k.includes('s')) h = l0.h + dv
      if (w < 0) { x += w; w = -w }
      if (h < 0) { y += h; h = -h }
      next = { ...l0, x, y, w, h }
    }
    ed.updateLayer(a.id!, next, false)
  }
  const layerUp = () => {
    const a = act.current
    if (!a || !a.layer) return
    act.current = null
    if (a.layer.type === 'redact') ed.setDraft(false)
    if (a.kind === 'new') {
      const l = (ed.recipe.layers || []).find(x => x.id === a.id)
      const tiny = l && (l.type === 'rect' || l.type === 'ellipse' || l.type === 'redact') && (l.w * W < 6 || l.h * H < 6)
      const tinyLine = l && (l.type === 'line' || l.type === 'arrow') && Math.hypot((l.x2 - l.x1) * W, (l.y2 - l.y1) * H) < 6
      if (tiny || tinyLine) { ed.set({ ...ed.recipe, layers: (ed.recipe.layers || []).filter(x => x.id !== a.id) }); return }
      ed.select(l && l.type !== 'draw' ? a.id! : null)
    }
    ed.commit()
  }

  const handles = (l: Layer, b: { x: number; y: number; w: number; h: number }) => {
    if (l.type === 'line' || l.type === 'arrow') return <>
      <span className="ov-handle" style={{ left: `${l.x1 * 100}%`, top: `${l.y1 * 100}%` }} onPointerDown={layerDown(l, 'p1')} onPointerMove={layerMove} onPointerUp={layerUp} />
      <span className="ov-handle" style={{ left: `${l.x2 * 100}%`, top: `${l.y2 * 100}%` }} onPointerDown={layerDown(l, 'p2')} onPointerMove={layerMove} onPointerUp={layerUp} />
    </>
    if (l.type === 'text' || l.type === 'sticker' || l.type === 'image') return <span className="ov-handle round" style={{ left: `${(b.x + b.w) * 100}%`, top: `${(b.y + b.h) * 100}%` }} onPointerDown={layerDown(l, 'scale')} onPointerMove={layerMove} onPointerUp={layerUp} title="Drag to change the size" />
    if (l.type === 'draw') return null
    return <>{(['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'] as const).map(k => <span key={k} className={`ov-handle h-${k}`} style={{ left: `${(b.x + (k.includes('e') ? b.w : k.includes('w') ? 0 : b.w / 2)) * 100}%`, top: `${(b.y + (k.includes('s') ? b.h : k.includes('n') ? 0 : b.h / 2)) * 100}%` }} onPointerDown={layerDown(l, k)} onPointerMove={layerMove} onPointerUp={layerUp} />)}</>
  }

  const drawing = ed.tool === 'hide' || ed.tool === 'heal' || ed.tool === 'cutout' || ed.tool === 'local' || (ed.tool === 'draw' && ed.drawMode !== 'select')
  return (
    <div ref={stage} className={`stage ${drawing ? 'drawing' : ''} ${zoom > 1 && !kinds && !crop ? 'pannable' : ''}`} onWheel={onWheel} onPointerDown={stageDown} onPointerMove={stageMove} onPointerUp={stageUp} onPointerCancel={stageUp}>
      <div className="stage-pic" style={{ left, top, width: dw, height: dh }}>
        <div ref={holder} className="stage-canvas" />
        {before && (comparing || split) && <div className="stage-before" style={split && !comparing ? { clipPath: `inset(0 ${100 - splitAt * 100}% 0 0)`, left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` } : { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}><div ref={beforeHolder} className="stage-canvas" /></div>}
        {split && !comparing && before && <div className="split-line" style={{ left: `${(box.x + box.w * splitAt) * 100}%` }} onPointerDown={e => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId) }}
          onPointerMove={e => { if (!(e.currentTarget as Element).hasPointerCapture(e.pointerId)) return; const r = imgEl.current!.getBoundingClientRect(); setSplitAt(clamp((e.clientX - r.left) / r.width, 0.02, 0.98)) }}><span>Before · After</span></div>}
        {comparing && <div className="stage-tag">Original</div>}

        <div ref={imgEl} className="stage-img" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}>
          {crop && !comparing && (
            <div className="crop-area">
              <div className="crop-box" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }} onPointerDown={cropDown('move')} onPointerMove={cropMove} onPointerUp={cropUp} onPointerCancel={cropUp}>
                {showGrid && <><i className="crop-grid v1" /><i className="crop-grid v2" /><i className="crop-grid h1" /><i className="crop-grid h2" /></>}
                {(['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'] as const).map(k => <span key={k} className={`crop-h h-${k}`} onPointerDown={cropDown(k)} onPointerMove={cropMove} onPointerUp={cropUp} onPointerCancel={cropUp} />)}
              </div>
            </div>
          )}
          {!comparing && ed.tool === 'local' && <LocalOverlay ed={ed} norm={norm} W={W} H={H} />}
          {!comparing && ed.tool === 'heal' && <HealOverlay ed={ed} norm={norm} W={W} H={H} />}
          {!comparing && ed.tool === 'cutout' && ed.recipe.cutout && <PaintArea ed={ed} norm={norm} onStroke={(st, commit) => {
            const c = ed.recipe.cutout!
            const key = ed.paint.keep ? 'keep' : 'remove'
            const list = [...(c[key] || [])]
            if (st.points.length === 1 && !commit) list.push(st); else list[list.length - 1] = st
            const next = { ...ed.recipe, cutout: { ...c, [key]: list } }
            if (commit) ed.commit(next); else ed.set(next)
          }} />}
          {kinds && !comparing && (
            <div className="layer-area" onPointerDown={newDown} onPointerMove={layerMove} onPointerUp={layerUp} onPointerCancel={layerUp}>
              {layers.map(l => {
                const b = layerBox(l, W, H)
                if (!b) return null
                const sel = ed.selected === l.id
                return (
                  <div key={l.id} className="ov-wrap">
                    <div className={`ov-box ${sel ? 'sel' : ''} t-${l.type}`} style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, transform: b.rot ? `rotate(${b.rot}deg)` : undefined }}
                      onPointerDown={layerDown(l, 'move')} onPointerMove={layerMove} onPointerUp={layerUp} onPointerCancel={layerUp}
                      onDoubleClick={() => { if (l.type === 'text') window.dispatchEvent(new CustomEvent('plab:edit-text', { detail: l.id })) }} title={(l as TextLayer).text || undefined} />
                    {sel && handles(l, b)}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      {cw > 0 && Math.abs(zoom - 1) > 0.01 && <button type="button" className="stage-zoom tnum" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} title="Fit to the window (0)">{Math.round(zoom * 100)}% · Fit</button>}
    </div>
  )
}

// ---- painting with a soft brush (local brush masks, fixing a cut-out) ----

function PaintArea({ ed, norm, onStroke }: { ed: Ed; norm: (e: { clientX: number; clientY: number }) => Pt; onStroke: (s: BrushStroke, commit: boolean) => void }) {
  const cur = useRef<BrushStroke | null>(null)
  const [hover, setHover] = useState<Pt | null>(null)
  const W = ed.base.w || 1, H = ed.base.h || 1, U = Math.min(W, H)
  const r = (ed.paint.size * U) / 2
  return (
    <div className="layer-area paint-area"
      onPointerDown={e => { if (e.button !== 0 && e.pointerType === 'mouse') return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); cur.current = { points: [norm(e)], size: ed.paint.size, erase: ed.tool === 'local' ? ed.paint.erase : undefined }; ed.setDraft(true); onStroke(cur.current, false) }}
      onPointerMove={e => {
        const p = norm(e); setHover(p)
        const st = cur.current; if (!st) return
        const last = st.points[st.points.length - 1]
        if (Math.hypot((p[0] - last[0]) * W, (p[1] - last[1]) * H) < Math.max(2, r / 4)) return
        cur.current = { ...st, points: [...st.points, [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]] }
        onStroke(cur.current, false)
      }}
      onPointerUp={() => { const st = cur.current; cur.current = null; ed.setDraft(false); if (st) onStroke(st, true) }}
      onPointerLeave={() => setHover(null)}>
      {hover && <span className="brush-ring" style={{ left: `${hover[0] * 100}%`, top: `${hover[1] * 100}%`, width: `${(2 * r / W) * 100}%`, aspectRatio: '1' }} />}
    </div>
  )
}

/** A red tint where the selected local adjustment acts. */
function MaskTint({ m, W, H }: { m: Mask; W: number; H: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const k = Math.min(1, 360 / Math.max(W, H))
    const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k))
    c.width = w; c.height = h
    const plane = maskPlane(m, w, h)
    const g = c.getContext('2d')!
    const d = g.createImageData(w, h)
    for (let i = 0; i < plane.length; i++) { d.data[i * 4] = 240; d.data[i * 4 + 1] = 40; d.data[i * 4 + 2] = 40; d.data[i * 4 + 3] = plane[i] * 140 }
    g.putImageData(d, 0, 0)
  }, [m, W, H])
  return <canvas ref={ref} className="mask-tint" />
}

function LocalOverlay({ ed, norm, W, H }: { ed: Ed; norm: (e: { clientX: number; clientY: number }) => Pt; W: number; H: number }) {
  const masks = ed.recipe.masks || []
  const m = masks.find(x => x.id === ed.selected)
  const drag = useRef<{ kind: string; start: Pt; m0: Mask } | null>(null)
  const update = (next: Mask, commit: boolean) => { const r = { ...ed.recipe, masks: masks.map(x => x.id === next.id ? next : x) }; if (commit) ed.commit(r); else ed.set(r) }
  const down = (kind: string) => (e: React.PointerEvent) => { if (!m) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = { kind, start: norm(e), m0: JSON.parse(JSON.stringify(m)) }; ed.setDraft(true) }
  const move = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return
    const p = norm(e), du = p[0] - d.start[0], dv = p[1] - d.start[1], m0 = d.m0
    if (m0.kind === 'linear') {
      const l = m0 as LinearMask
      if (d.kind === 'p1') update({ ...l, x1: p[0], y1: p[1] }, false)
      else if (d.kind === 'p2') update({ ...l, x2: p[0], y2: p[1] }, false)
      else update({ ...l, x1: l.x1 + du, y1: l.y1 + dv, x2: l.x2 + du, y2: l.y2 + dv }, false)
    } else if (m0.kind === 'radial') {
      const rm = m0 as RadialMask
      if (d.kind === 'rx') update({ ...rm, rx: Math.max(0.02, Math.abs(p[0] - rm.x)) }, false)
      else if (d.kind === 'ry') update({ ...rm, ry: Math.max(0.02, Math.abs(p[1] - rm.y)) }, false)
      else update({ ...rm, x: rm.x + du, y: rm.y + dv }, false)
    }
  }
  const up = () => { if (drag.current) { drag.current = null; ed.setDraft(false); ed.commit() } }
  if (!m) return null
  return (
    <>
      {ed.paint.show && <MaskTint m={m} W={W} H={H} />}
      {m.kind === 'brush' && <PaintArea ed={ed} norm={norm} onStroke={(st, commit) => {
        const bm = (ed.recipe.masks || []).find(x => x.id === m.id) as BrushMask
        const strokes = [...bm.strokes]
        if (st.points.length === 1 && !commit) strokes.push(st); else strokes[strokes.length - 1] = st
        update({ ...bm, strokes }, commit)
      }} />}
      {m.kind === 'linear' && (() => { const l = m as LinearMask; return <div className="layer-area" onPointerMove={move} onPointerUp={up}>
        <svg className="mask-lines" viewBox={`0 0 ${W} ${H}`} width="100%" height="100%"><line x1={l.x1 * W} y1={l.y1 * H} x2={l.x2 * W} y2={l.y2 * H} /></svg>
        <span className="ov-handle round" style={{ left: `${l.x1 * 100}%`, top: `${l.y1 * 100}%` }} onPointerDown={down('p1')} title="Full effect from here" />
        <span className="ov-handle" style={{ left: `${l.x2 * 100}%`, top: `${l.y2 * 100}%` }} onPointerDown={down('p2')} title="…fading out to here" />
        <span className="ov-handle move" style={{ left: `${(l.x1 + l.x2) * 50}%`, top: `${(l.y1 + l.y2) * 50}%` }} onPointerDown={down('move')} title="Move" />
      </div> })()}
      {m.kind === 'radial' && (() => { const rm = m as RadialMask; return <div className="layer-area" onPointerMove={move} onPointerUp={up}>
        <div className="mask-ellipse" style={{ left: `${(rm.x - rm.rx) * 100}%`, top: `${(rm.y - rm.ry) * 100}%`, width: `${rm.rx * 200}%`, height: `${rm.ry * 200}%` }} onPointerDown={down('move')} />
        <span className="ov-handle" style={{ left: `${(rm.x + rm.rx) * 100}%`, top: `${rm.y * 100}%` }} onPointerDown={down('rx')} />
        <span className="ov-handle" style={{ left: `${rm.x * 100}%`, top: `${(rm.y + rm.ry) * 100}%` }} onPointerDown={down('ry')} />
      </div> })()}
    </>
  )
}

function HealOverlay({ ed, norm, W, H }: { ed: Ed; norm: (e: { clientX: number; clientY: number }) => Pt; W: number; H: number }) {
  const heals = ed.recipe.heals || []
  const U = Math.min(W, H)
  const drag = useRef<{ id: string; which: 't' | 's'; start: Pt; h0: Heal } | null>(null)
  const add = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const [x, y] = norm(e)
    const v = ed.view()
    const r = ed.paint.size / 2
    let src: [number, number] = [x + r * 2.4 * (U / W), y]
    if (v) {
      const c = document.createElement('canvas'), k = Math.min(1, 600 / Math.max(v.width, v.height))
      c.width = Math.round(v.width * k); c.height = Math.round(v.height * k)
      const g = c.getContext('2d', { willReadFrequently: true })!
      // the view may have a frame around it: take the picture part
      const fx = (v.width - W) / 2, fy = (v.height - H) / 2
      g.drawImage(v, Math.max(0, fx), Math.max(0, fy), Math.min(W, v.width), Math.min(H, v.height), 0, 0, c.width, c.height)
      src = bestSource(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, x, y, r)
    }
    const h: Heal = { id: newId(), x, y, sx: src[0], sy: src[1], r, mode: ed.paint.heal }
    ed.commit({ ...ed.recipe, heals: [...heals, h] })
    ed.select(h.id)
  }
  const down = (h: Heal, which: 't' | 's') => (e: React.PointerEvent) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); ed.select(h.id); drag.current = { id: h.id, which, start: norm(e), h0: { ...h } } }
  const move = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return
    const p = norm(e), du = p[0] - d.start[0], dv = p[1] - d.start[1]
    const n = d.which === 't' ? { ...d.h0, x: d.h0.x + du, y: d.h0.y + dv } : { ...d.h0, sx: d.h0.sx + du, sy: d.h0.sy + dv }
    ed.set({ ...ed.recipe, heals: heals.map(x => x.id === n.id ? n : x) })
  }
  const up = () => { if (drag.current) { drag.current = null; ed.commit() } }
  return (
    <div className="layer-area paint-area" onPointerDown={add} onPointerMove={move} onPointerUp={up}>
      {heals.map(h => {
        const d = (2 * h.r * U / W) * 100, sel = ed.selected === h.id
        return <div key={h.id}>
          {sel && <svg className="mask-lines" viewBox={`0 0 ${W} ${H}`} width="100%" height="100%"><line x1={h.sx * W} y1={h.sy * H} x2={h.x * W} y2={h.y * H} strokeDasharray="4 4" /></svg>}
          {sel && <span className="heal-ring src" style={{ left: `${h.sx * 100}%`, top: `${h.sy * 100}%`, width: `${d}%` }} onPointerDown={down(h, 's')} title="Painted from here: drag to choose another place" />}
          <span className={`heal-ring ${sel ? 'sel' : ''}`} style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%`, width: `${d}%` }} onPointerDown={down(h, 't')} />
        </div>
      })}
    </div>
  )
}
