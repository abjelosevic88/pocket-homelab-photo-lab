// A labelled slider: live while dragging (onChange), one undo step when let go (onCommit).
// Double-click (or the reset dot) puts it back to its starting value.
import { useRef } from 'react'

export function Slider({ label, value, min, max, step = 1, zero = 0, unit = '', onChange, onCommit, onDraft, help, gradient }: {
  label: string; value: number; min: number; max: number; step?: number; zero?: number; unit?: string
  onChange: (v: number) => void; onCommit: () => void; onDraft?: (on: boolean) => void; help?: string; gradient?: string
}) {
  const dragging = useRef(false)
  const end = () => { if (dragging.current) { dragging.current = false; onDraft?.(false); onCommit() } }
  const changed = Math.abs(value - zero) > 1e-9
  const pct = ((value - min) / (max - min)) * 100
  const zp = ((zero - min) / (max - min)) * 100
  const fill = `linear-gradient(to right, transparent ${Math.min(pct, zp)}%, var(--accent) ${Math.min(pct, zp)}%, var(--accent) ${Math.max(pct, zp)}%, transparent ${Math.max(pct, zp)}%)`
  return (
    <div className={`slider ${changed ? 'changed' : ''}`} title={help}>
      <div className="slider-head">
        <label className="slider-label" onDoubleClick={() => { onChange(zero); onCommit() }}>{label}</label>
        {changed && <button type="button" className="slider-reset" onClick={() => { onChange(zero); onCommit() }} aria-label={`Reset ${label}`} title="Reset">↺</button>}
        <input className="slider-num tnum" type="number" value={Number(value.toFixed(step < 1 ? 1 : 0))} min={min} max={max} step={step} aria-label={`${label} value`}
          onChange={e => { const v = Number(e.target.value); if (!Number.isNaN(v)) onChange(Math.max(min, Math.min(max, v))) }} onBlur={onCommit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        {unit && <span className="slider-unit muted">{unit}</span>}
      </div>
      <input type="range" className="slider-range" min={min} max={max} step={step} value={value} aria-label={label}
        style={gradient ? { ['--track' as string]: gradient } : { backgroundImage: `${fill}, linear-gradient(var(--surface-3), var(--surface-3))` }}
        onPointerDown={() => { dragging.current = true; onDraft?.(true) }} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
        onKeyUp={onCommit} onDoubleClick={() => { onChange(zero); onCommit() }}
        onChange={e => onChange(Number(e.target.value))} />
    </div>
  )
}
