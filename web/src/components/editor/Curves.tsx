// The tone curve: drag points, click to add one, double-click a point to remove it.
// Drawn at its real size (measured), never stretched.
import { useCallback, useMemo, useRef, useState } from 'react'
import type { Curves as CurvesT, Pt } from '../../lib/recipe'
import { curveTable } from '../../lib/render/pixels'
import { Segmented } from '../ui'

const STRAIGHT: Pt[] = [[0, 0], [255, 255]]
type Ch = 'rgb' | 'r' | 'g' | 'b'
const COLORS: Record<Ch, string> = { rgb: 'var(--text)', r: '#e03131', g: '#2f9e44', b: '#1c7ed6' }

function useSize() {
  const [w, setW] = useState(260)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: Element | null) => {
    ro.current?.disconnect(); ro.current = null
    if (!el) return
    const m = () => { const cw = Math.round(el.getBoundingClientRect().width); if (cw > 0) setW(Math.min(cw, 340)) }
    m(); ro.current = new ResizeObserver(m); ro.current.observe(el)
  }, [])
  return [ref, w] as const
}

export function CurvesEditor({ value, onChange, onCommit }: { value: Partial<CurvesT> | null | undefined; onChange: (c: Partial<CurvesT>) => void; onCommit: () => void }) {
  const [ch, setCh] = useState<Ch>('rgb')
  const [ref, W] = useSize()
  const S = W
  const pts = (value?.[ch] && value[ch]!.length >= 2 ? value[ch]! : STRAIGHT)
  const drag = useRef<number | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const path = useMemo(() => {
    const t = curveTable(pts)
    let d = ''
    for (let x = 0; x <= 255; x += 3) { const y = t ? t[x] : x; d += `${x ? 'L' : 'M'}${(x / 255) * S},${S - (Math.max(0, Math.min(255, y)) / 255) * S}` }
    return d
  }, [pts, S])
  const toVal = (e: React.PointerEvent): Pt => {
    const r = svg.current!.getBoundingClientRect()
    return [Math.round(Math.max(0, Math.min(255, ((e.clientX - r.left) / r.width) * 255))), Math.round(Math.max(0, Math.min(255, (1 - (e.clientY - r.top) / r.height) * 255)))]
  }
  const setPts = (p: Pt[]) => onChange({ ...(value || {}), [ch]: p })
  const down = (e: React.PointerEvent) => {
    const v = toVal(e)
    let i = pts.findIndex(p => Math.abs(p[0] - v[0]) < 12 && Math.abs(p[1] - v[1]) < 18)
    let next = pts
    if (i < 0) { next = [...pts, v].sort((a, b) => a[0] - b[0]); i = next.findIndex(p => p === v); setPts(next) }
    drag.current = i
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    if (drag.current === null) return
    const v = toVal(e)
    const i = drag.current
    const next = pts.map(p => [...p] as Pt)
    const lo = i > 0 ? next[i - 1][0] + 1 : 0, hi = i < next.length - 1 ? next[i + 1][0] - 1 : 255
    next[i] = [i === 0 ? Math.min(v[0], hi) : i === next.length - 1 ? Math.max(v[0], lo) : Math.max(lo, Math.min(hi, v[0])), v[1]]
    setPts(next)
  }
  const up = () => { if (drag.current !== null) { drag.current = null; onCommit() } }
  const remove = (i: number) => { if (i === 0 || i === pts.length - 1) return; setPts(pts.filter((_, k) => k !== i)); onCommit() }
  return (
    <div className="curves" ref={ref}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Segmented size="sm" value={ch} onChange={setCh} options={[{ value: 'rgb', label: 'All' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }]} />
        <button type="button" className="btn ghost sm" onClick={() => { setPts(STRAIGHT); onCommit() }}>Reset</button>
      </div>
      <svg ref={svg} width={S} height={S} viewBox={`0 0 ${S} ${S}`} className="curves-box" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {[1, 2, 3].map(k => <g key={k}><line x1={(k * S) / 4} y1={0} x2={(k * S) / 4} y2={S} className="curves-grid" /><line x1={0} y1={(k * S) / 4} x2={S} y2={(k * S) / 4} className="curves-grid" /></g>)}
        <line x1={0} y1={S} x2={S} y2={0} className="curves-diag" />
        <path d={path} fill="none" stroke={COLORS[ch]} strokeWidth={2} />
        {pts.map((p, i) => <circle key={i} cx={(p[0] / 255) * S} cy={S - (p[1] / 255) * S} r={6} className="curves-pt" style={{ stroke: COLORS[ch] }} onDoubleClick={() => remove(i)} />)}
      </svg>
      <p className="muted small">Drag the line: up brightens, down darkens; an S shape adds contrast. Double-click a point to remove it.</p>
    </div>
  )
}
