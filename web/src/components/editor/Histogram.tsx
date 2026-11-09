// The histogram of what you see: red, green, blue and brightness, drawn at its real size.
import { useCallback, useEffect, useRef, useState } from 'react'
import { histogram } from '../../lib/render/pixels'

function useWidth(fallback: number) {
  const [w, setW] = useState(fallback)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: Element | null) => {
    ro.current?.disconnect(); ro.current = null
    if (!el) return
    const measure = () => { const cw = Math.round(el.getBoundingClientRect().width); if (cw > 0) setW(cw) }
    measure(); ro.current = new ResizeObserver(measure); ro.current.observe(el)
  }, [])
  return [ref, w] as const
}

export function Histogram({ source, version }: { source: HTMLCanvasElement | null; version: number }) {
  const [ref, W] = useWidth(280)
  const H = 72
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvas.current
    if (!c || !source || !source.width) return
    const k = Math.min(1, 320 / Math.max(source.width, source.height))
    const s = document.createElement('canvas')
    s.width = Math.max(1, Math.round(source.width * k)); s.height = Math.max(1, Math.round(source.height * k))
    const sg = s.getContext('2d', { willReadFrequently: true })!
    sg.drawImage(source, 0, 0, s.width, s.height)
    const h = histogram(sg.getImageData(0, 0, s.width, s.height).data, 1)
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr)
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, W, H)
    let max = 1
    for (const arr of [h.r, h.g, h.b]) for (let i = 2; i < 254; i++) max = Math.max(max, arr[i])
    const draw = (arr: Uint32Array, color: string) => {
      g.beginPath(); g.moveTo(0, H)
      for (let i = 0; i < 256; i++) g.lineTo((i / 255) * W, H - Math.min(1, Math.sqrt(arr[i] / max)) * (H - 2))
      g.lineTo(W, H); g.closePath(); g.fillStyle = color; g.fill()
    }
    g.globalCompositeOperation = 'lighter'
    draw(h.r, 'rgba(230, 60, 60, .55)'); draw(h.g, 'rgba(60, 190, 80, .55)'); draw(h.b, 'rgba(70, 110, 240, .55)')
    g.globalCompositeOperation = 'source-over'
  }, [source, version, W])
  return <div ref={ref} className="histo"><canvas ref={canvas} style={{ width: W, height: H }} aria-label="Histogram" role="img" /></div>
}
