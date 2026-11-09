// The picture in the middle: zoom and move it, crop it, drag text, shapes
// and drawings around, draw on it, and hide parts of it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ASPECTS, newId, type Crop, type DrawLayer, type Layer, type Pt, type TextLayer } from '../../lib/recipe'
import { frameBox, textBox } from '../../lib/render/engine'
import type { Ed } from './types'

const measureCtx = (() => { let c: CanvasRenderingContext2D | null = null; return () => (c ||= document.createElement('canvas').getContext('2d')!) })()
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v))

/** A layer's box (fractions of the picture) for hit tests and handles. */
export function layerBox(l: Layer, W: number, H: number): { x: number; y: number; w: number; h: number; rot: number } | null {
  switch (l.type) {
    case 'text': { const b = textBox(measureCtx(), l, W, H); const p = b.size * 0.3; return { x: l.x - (b.w / 2 + p) / W, y: l.y - (b.h / 2 + p * 0.6) / H, w: (b.w + 2 * p) / W, h: (b.h + p * 1.2) / H, rot: l.rotate || 0 } }
    case 'sticker': { const s = l.size * Math.min(W, H); return { x: l.x - s / 2 / W, y: l.y - s / 2 / H, w: s / W, h: s / H, rot: l.rotate || 0 } }
    case 'rect': case 'ellipse': case 'redact': return { x: Math.min(l.x, l.x + l.w), y: Math.min(l.y, l.y + l.h), w: Math.abs(l.w), h: Math.abs(l.h), rot: 0 }
    case 'line': case 'arrow': { const pad = Math.max(l.width * Math.min(W, H) * 2, 8) ; return { x: Math.min(l.x1, l.x2) - pad / W, y: Math.min(l.y1, l.y2) - pad / H, w: Math.abs(l.x2 - l.x1) + 2 * pad / W, h: Math.abs(l.y2 - l.y1) + 2 * pad / H, rot: 0 } }
    case 'draw': { if (!l.points.length) return null; const xs = l.points.map(p => p[0]), ys = l.points.map(p => p[1]); const pad = l.width * Math.min(W, H) / 2; return { x: Math.min(...xs) - pad / W, y: Math.min(...ys) - pad / H, w: Math.max(...xs) - Math.min(...xs) + 2 * pad / W, h: Math.max(...ys) - Math.min(...ys) + 2 * pad / H, rot: 0 } }
  }
  return null
}

const TOOL_LAYERS: Record<string, Layer['type'][]> = { text: ['text', 'sticker'], draw: ['draw', 'rect', 'ellipse', 'line', 'arrow', 'sticker'], hide: ['redact'] }

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
        case 'text': case 'sticker': next = { ...l0, x: l0.x + du, y: l0.y + dv }; break
        case 'rect': case 'ellipse': case 'redact': next = { ...l0, x: l0.x + du, y: l0.y + dv }; break
        case 'line': case 'arrow': next = { ...l0, x1: l0.x1 + du, y1: l0.y1 + dv, x2: l0.x2 + du, y2: l0.y2 + dv }; break
        case 'draw': next = { ...l0, points: l0.points.map(([x, y]) => [x + du, y + dv] as Pt) }; break
      }
    } else if (a.kind === 'p1' && (l0.type === 'line' || l0.type === 'arrow')) next = { ...l0, x1: p[0], y1: p[1] }
    else if (a.kind === 'p2' && (l0.type === 'line' || l0.type === 'arrow')) next = { ...l0, x2: p[0], y2: p[1] }
    else if (a.kind === 'scale' && (l0.type === 'text' || l0.type === 'sticker')) {
      const d0 = Math.hypot((a.start[0] - l0.x) * W, (a.start[1] - l0.y) * H), d1 = Math.hypot((p[0] - l0.x) * W, (p[1] - l0.y) * H)
      next = { ...l0, size: clamp(l0.size * (d1 / Math.max(4, d0)), 0.01, 1.5) }
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
    if (l.type === 'text' || l.type === 'sticker') return <span className="ov-handle round" style={{ left: `${(b.x + b.w) * 100}%`, top: `${(b.y + b.h) * 100}%` }} onPointerDown={layerDown(l, 'scale')} onPointerMove={layerMove} onPointerUp={layerUp} title="Drag to change the size" />
    if (l.type === 'draw') return null
    return <>{(['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'] as const).map(k => <span key={k} className={`ov-handle h-${k}`} style={{ left: `${(b.x + (k.includes('e') ? b.w : k.includes('w') ? 0 : b.w / 2)) * 100}%`, top: `${(b.y + (k.includes('s') ? b.h : k.includes('n') ? 0 : b.h / 2)) * 100}%` }} onPointerDown={layerDown(l, k)} onPointerMove={layerMove} onPointerUp={layerUp} />)}</>
  }

  const drawing = ed.tool === 'hide' || (ed.tool === 'draw' && ed.drawMode !== 'select')
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
