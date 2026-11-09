// Turning an edit into pixels in the browser: geometry on a canvas (crop,
// turn, straighten, mirror, size), the pixel step in a worker, then text,
// drawings and stickers, then the frame. The same code makes the editor's
// preview, thumbnails and the full-size picture that is saved.

import { fontCSS, perspectiveOn, pixelsChange, type BrushStroke, type Layer, type Recipe, type Frame, type Crop } from '../recipe'
import { process, hexRGB } from './pixels'

export type Canvas = HTMLCanvasElement

export function makeCanvas(w: number, h: number): Canvas {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h))
  return c
}
const ctx2d = (c: Canvas) => c.getContext('2d', { willReadFrequently: false })!

/** Loads a picture with the camera's rotation applied. */
export async function loadBitmap(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  const res = await fetch(url, { credentials: 'same-origin', signal })
  if (!res.ok) throw new Error(`could not load the picture (HTTP ${res.status})`)
  const blob = await res.blob()
  return decodeBlob(blob)
}
export async function decodeBlob(blob: Blob): Promise<ImageBitmap> {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }) } catch {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
    const { isHeic, decodeHeic } = await import('../heic')
    if (isHeic(head)) return decodeHeic(blob)
    // older Safari: go through an <img>
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      await img.decode()
      return await createImageBitmap(img)
    } catch { throw new Error('this browser cannot open this kind of picture') } finally { URL.revokeObjectURL(url) }
  }
}

// ---- geometry ----

const RAD = Math.PI / 180
export const quarter = (r: Recipe) => ((((r.rotate || 0) % 360) + 360) % 360) / 90
/** The picture's size once turned by quarter turns. */
export function orientedSize(r: Recipe, w: number, h: number): [number, number] { return quarter(r) % 2 ? [h, w] : [w, h] }
/** How much a straightened picture is enlarged so no empty corners show. */
export function coverScale(fw: number, fh: number, deg: number): number {
  if (!deg) return 1
  const t = Math.abs(deg * RAD), c = Math.cos(t), s = Math.sin(t)
  return Math.max((fw * c + fh * s) / fw, (fw * s + fh * c) / fh)
}
export const fullCrop: Crop = { x: 0, y: 0, w: 1, h: 1 }
export const cropOf = (r: Recipe): Crop => r.crop && r.crop.w > 0 && r.crop.h > 0 ? r.crop : fullCrop
/** The cropped picture's size in source pixels. */
export function cropSize(r: Recipe, w: number, h: number): [number, number] { const [fw, fh] = orientedSize(r, w, h); const c = cropOf(r); return [fw * c.w, fh * c.h] }
/** The finished picture's size before the frame (resize applied). */
export function imageSize(r: Recipe, w: number, h: number): [number, number] {
  if (r.resize && r.resize.w > 0 && r.resize.h > 0) return [r.resize.w, r.resize.h]
  const [cw, ch] = cropSize(r, w, h)
  return [Math.max(1, Math.round(cw)), Math.max(1, Math.round(ch))]
}
/** The finished picture's size with the frame. */
export function finalSize(r: Recipe, w: number, h: number): [number, number] { const [iw, ih] = imageSize(r, w, h); const f = frameBox(r.frame, iw, ih); return [f.W, f.H] }

/**
 * Draws the source turned, mirrored, straightened and cropped. sx, sy: the
 * output size per source pixel (they differ only when a resize changes the
 * shape). full = the whole straightened frame, without the crop (cropping).
 */
export function drawGeometry(src: CanvasImageSource, sw: number, sh: number, r: Recipe, sx: number, sy: number = sx, full = false): Canvas {
  if (perspectiveOn(r.perspective)) {
    // the whole frame, put upright, then the crop out of it
    const [fw, fh] = orientedSize(r, sw, sh)
    const c = full ? fullCrop : cropOf(r)
    const ow = Math.max(1, Math.round(fw * c.w * sx)), oh = Math.max(1, Math.round(fh * c.h * sy))
    const kx = ow / (fw * c.w), ky = oh / (fh * c.h)
    const whole = warpPerspective(drawGeometry(src, sw, sh, { ...r, perspective: null }, kx, ky, true), r.perspective!.v, r.perspective!.h)
    if (full) return whole
    const out = makeCanvas(ow, oh)
    const g = ctx2d(out)
    g.imageSmoothingQuality = 'high'
    g.drawImage(whole, c.x * whole.width, c.y * whole.height, c.w * whole.width, c.h * whole.height, 0, 0, ow, oh)
    return out
  }
  const [fw, fh] = orientedSize(r, sw, sh)
  const c = full ? fullCrop : cropOf(r)
  const out = makeCanvas(fw * c.w * sx, fh * c.h * sy)
  const g = ctx2d(out)
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.scale(out.width / (fw * c.w), out.height / (fh * c.h))
  g.translate(-c.x * fw, -c.y * fh)
  g.translate(fw / 2, fh / 2)
  const deg = r.straighten || 0
  if (deg) { g.rotate(deg * RAD); const k = coverScale(fw, fh, deg); g.scale(k, k) }
  g.scale(r.flipH ? -1 : 1, r.flipV ? -1 : 1)
  g.rotate(quarter(r) * 90 * RAD)
  // big shrinks look smoother in two steps
  const ratio = Math.min(out.width / (fw * c.w), out.height / (fh * c.h))
  if (ratio < 0.3 && src instanceof ImageBitmap) {
    const half = makeCanvas(sw * Math.max(ratio * 2, 0.02), sh * Math.max(ratio * 2, 0.02))
    const hg = ctx2d(half); hg.imageSmoothingQuality = 'high'; hg.drawImage(src, 0, 0, half.width, half.height)
    g.drawImage(half, -sw / 2, -sh / 2, sw, sh)
  } else g.drawImage(src, -sw / 2, -sh / 2, sw, sh)
  return out
}

/**
 * Keystone correction: v > 0 straightens lines that lean in at the top
 * (buildings shot from below), v < 0 at the bottom; h the same sideways.
 * The picture is resampled from a smaller quad inside it, so no empty
 * corners appear.
 */
export function warpPerspective(c: Canvas, v: number, h: number): Canvas {
  const W = c.width, H = c.height
  const a = (Math.abs(v) / 100) * 0.3, b = (Math.abs(h) / 100) * 0.3
  // the source quad (fractions): TL, TR, BR, BL
  const q = [[0, 0], [1, 0], [1, 1], [0, 1]]
  if (v > 0) { q[0][0] += a; q[1][0] -= a } else if (v < 0) { q[3][0] += a; q[2][0] -= a }
  if (h > 0) { q[1][1] += b; q[2][1] -= b } else if (h < 0) { q[0][1] += b; q[3][1] -= b }
  const [x0, y0] = q[0], [x1, y1] = q[1], [x2, y2] = q[2], [x3, y3] = q[3]
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3
  const den = dx1 * dy2 - dx2 * dy1
  const G = den ? (dx3 * dy2 - dx2 * dy3) / den : 0, Hh = den ? (dx1 * dy3 - dx3 * dy1) / den : 0
  const A = x1 - x0 + G * x1, B = x3 - x0 + Hh * x3, C = x0, D = y1 - y0 + G * y1, E = y3 - y0 + Hh * y3, F = y0
  const sp = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data
  const out = makeCanvas(W, H)
  const od = new ImageData(W, H)
  const dp = od.data
  for (let yy = 0; yy < H; yy++) {
    const t = (yy + 0.5) / H
    for (let xx = 0; xx < W; xx++) {
      const s = (xx + 0.5) / W
      const z = G * s + Hh * t + 1
      const fx = ((A * s + B * t + C) / z) * W - 0.5, fy = ((D * s + E * t + F) / z) * H - 0.5
      const ix = Math.max(0, Math.min(W - 2, Math.floor(fx))), iy = Math.max(0, Math.min(H - 2, Math.floor(fy)))
      const ax = Math.max(0, Math.min(1, fx - ix)), ay = Math.max(0, Math.min(1, fy - iy))
      const i00 = (iy * W + ix) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4
      const o = (yy * W + xx) * 4
      for (let k = 0; k < 4; k++) {
        const top = sp[i00 + k] + (sp[i10 + k] - sp[i00 + k]) * ax, bot = sp[i01 + k] + (sp[i11 + k] - sp[i01 + k]) * ax
        dp[o + k] = top + (bot - top) * ay
      }
    }
  }
  ctx2d(out).putImageData(od, 0, 0)
  return out
}

// ---- the pixel step in a worker ----

let worker: Worker | null = null
let jobSeq = 0
const pending = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>()
function getWorker(): Worker | null {
  if (worker) return worker
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; buf?: ArrayBuffer; error?: string }>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      if (e.data.error || !e.data.buf) p.reject(new Error(e.data.error || 'the picture could not be processed'))
      else p.resolve(e.data.buf)
    }
    worker.onerror = () => { for (const p of pending.values()) p.reject(new Error('the picture could not be processed')); pending.clear(); worker = null }
  } catch { worker = null }
  return worker
}

/** Runs the pixel part of the edit on a canvas (in place). */
export async function runPixels(c: Canvas, r: Recipe): Promise<Canvas> {
  if (!pixelsChange(r)) return c
  const g = c.getContext('2d', { willReadFrequently: true })!
  const data = g.getImageData(0, 0, c.width, c.height)
  const wk = getWorker()
  if (!wk || c.width * c.height < 40_000) {
    process(data.data, c.width, c.height, r)
  } else {
    const id = ++jobSeq
    const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      wk.postMessage({ id, w: c.width, h: c.height, buf: data.data.buffer, recipe: r }, [data.data.buffer])
    })
    g.putImageData(new ImageData(new Uint8ClampedArray(buf), c.width, c.height), 0, 0)
    return c
  }
  g.putImageData(data, 0, 0)
  return c
}

// ---- text, drawings, stickers, watermark ----

export function drawLayers(g: CanvasRenderingContext2D, layers: Layer[] | undefined, W: number, H: number, skip?: string) {
  const U = Math.min(W, H)
  for (const l of layers || []) {
    if (l.hidden || l.type === 'redact' || l.id === skip) continue
    g.save()
    g.globalAlpha = l.opacity ?? 1
    switch (l.type) {
      case 'text': drawText(g, l, W, H, U); break
      case 'rect': case 'ellipse': {
        const x = l.x * W, y = l.y * H, w = l.w * W, h = l.h * H
        g.beginPath()
        if (l.type === 'ellipse') g.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2)
        else if (l.radius) g.roundRect(x, y, w, h, Math.min(Math.abs(w), Math.abs(h)) / 2 * l.radius)
        else g.rect(x, y, w, h)
        if (l.fill) { g.fillStyle = l.fill; g.fill() }
        if (l.stroke && l.width > 0) { g.strokeStyle = l.stroke; g.lineWidth = l.width * U; g.lineJoin = 'round'; g.stroke() }
        break
      }
      case 'line': case 'arrow': {
        const x1 = l.x1 * W, y1 = l.y1 * H, x2 = l.x2 * W, y2 = l.y2 * H, lw = l.width * U
        g.strokeStyle = l.stroke; g.fillStyle = l.stroke; g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round'
        const ang = Math.atan2(y2 - y1, x2 - x1), head = Math.max(lw * 3.2, U * 0.02)
        const ex = l.type === 'arrow' ? x2 - Math.cos(ang) * head * 0.6 : x2, ey = l.type === 'arrow' ? y2 - Math.sin(ang) * head * 0.6 : y2
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(ex, ey); g.stroke()
        if (l.type === 'arrow') {
          g.beginPath(); g.moveTo(x2, y2)
          g.lineTo(x2 - Math.cos(ang - 0.45) * head, y2 - Math.sin(ang - 0.45) * head)
          g.lineTo(x2 - Math.cos(ang + 0.45) * head, y2 - Math.sin(ang + 0.45) * head)
          g.closePath(); g.fill()
        }
        break
      }
      case 'draw': {
        if (l.points.length < 1) break
        g.strokeStyle = l.stroke; g.lineWidth = l.width * U; g.lineCap = l.marker ? 'square' : 'round'; g.lineJoin = 'round'
        if (l.marker) g.globalAlpha = (l.opacity ?? 1) * 0.45
        g.beginPath()
        const p = l.points
        g.moveTo(p[0][0] * W, p[0][1] * H)
        if (p.length === 1) g.lineTo(p[0][0] * W + 0.01, p[0][1] * H)
        for (let i = 1; i < p.length - 1; i++) {
          const mx = (p[i][0] + p[i + 1][0]) / 2 * W, my = (p[i][1] + p[i + 1][1]) / 2 * H
          g.quadraticCurveTo(p[i][0] * W, p[i][1] * H, mx, my)
        }
        if (p.length > 1) g.lineTo(p[p.length - 1][0] * W, p[p.length - 1][1] * H)
        g.stroke()
        break
      }
      case 'image': {
        const bmp = layerBitmaps.get(layerKey(l))
        if (!bmp) break
        const w = l.w * W, h = w * (l.aspect || bmp.height / bmp.width)
        g.translate(l.x * W, l.y * H)
        if (l.rotate) g.rotate(l.rotate * RAD)
        g.imageSmoothingQuality = 'high'
        g.drawImage(bmp, -w / 2, -h / 2, w, h)
        break
      }
      case 'sticker': {
        const s = l.size * U
        g.translate(l.x * W, l.y * H)
        if (l.rotate) g.rotate(l.rotate * RAD)
        g.font = `${s}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`
        g.textAlign = 'center'; g.textBaseline = 'middle'
        g.fillText(l.emoji, 0, s * 0.05)
        break
      }
      case 'watermark': {
        const s = Math.max(6, l.size * U)
        g.font = `600 ${s}px ${fontCSS('sans')}`
        g.fillStyle = l.color
        g.textBaseline = 'middle'
        if (l.tile) {
          const tw = g.measureText(l.text).width + s * 3
          g.translate(W / 2, H / 2); g.rotate(-30 * RAD)
          const R = Math.hypot(W, H)
          g.textAlign = 'center'
          for (let y = -R; y < R; y += s * 3.2) for (let x = -R; x < R; x += tw) g.fillText(l.text, x + ((y / (s * 3.2)) % 2 ? tw / 2 : 0), y)
        } else {
          const m = U * 0.035
          const pos: Record<string, [number, number, CanvasTextAlign]> = { br: [W - m, H - m - s / 2, 'right'], bl: [m, H - m - s / 2, 'left'], tr: [W - m, m + s / 2, 'right'], tl: [m, m + s / 2, 'left'], c: [W / 2, H / 2, 'center'] }
          const [x, y, al] = pos[l.corner] || pos.br
          g.textAlign = al
          g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = s * 0.2
          g.fillText(l.text, x, y)
        }
        break
      }
    }
    g.restore()
  }
}

/** The text's box in picture pixels (for handles and hit tests). */
export function textBox(g: CanvasRenderingContext2D, l: Extract<Layer, { type: 'text' }>, W: number, H: number): { w: number; h: number; lines: string[]; size: number; lineH: number } {
  const U = Math.min(W, H)
  const size = Math.max(4, l.size * U)
  g.font = `${l.italic ? 'italic ' : ''}${l.bold ? '700 ' : '400 '}${size}px ${fontCSS(l.font)}`
  const lines = (l.text || ' ').split('\n')
  const w = Math.max(...lines.map(t => g.measureText(t).width), size * 0.3)
  const lineH = size * 1.2
  return { w, h: lineH * lines.length, lines, size, lineH }
}

function drawText(g: CanvasRenderingContext2D, l: Extract<Layer, { type: 'text' }>, W: number, H: number, _U: number) {
  const box = textBox(g, l, W, H)
  const { size, lineH, lines } = box
  g.translate(l.x * W, l.y * H)
  if (l.rotate) g.rotate(l.rotate * RAD)
  const align = l.align || 'center'
  g.textAlign = align
  g.textBaseline = 'middle'
  const ox = align === 'left' ? -box.w / 2 : align === 'right' ? box.w / 2 : 0
  const top = -box.h / 2 + lineH / 2
  if (l.bg) {
    const p = size * 0.35
    g.fillStyle = l.bg
    g.beginPath(); g.roundRect(-box.w / 2 - p, -box.h / 2 - p * 0.6, box.w + 2 * p, box.h + p * 1.2, size * 0.25); g.fill()
  }
  if (l.shadow) { g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = size * 0.18; g.shadowOffsetY = size * 0.05 }
  lines.forEach((t, i) => {
    const y = top + i * lineH
    if (l.outline) { g.save(); g.shadowColor = 'transparent'; g.lineWidth = size * 0.12; g.strokeStyle = l.outline; g.lineJoin = 'round'; g.strokeText(t, ox, y); g.restore() }
    g.fillStyle = l.color
    g.fillText(t, ox, y)
  })
}

// ---- pictures on top (a logo, a second photo) ----

const layerBitmaps = new Map<string, ImageBitmap>()
const layerKey = (l: Extract<Layer, { type: 'image' }>) => `${l.src}:${l.updated || ''}`

/** Loads the pictures the edit puts on top (their current look); call before finish(). */
export async function prepareLayers(r: Recipe): Promise<boolean> {
  let loaded = false
  for (const l of r.layers || []) {
    if (l.type !== 'image' || layerBitmaps.has(layerKey(l))) continue
    try { layerBitmaps.set(layerKey(l), await loadBitmap(`/api/v1/images/${l.src}/preview?v=${encodeURIComponent(l.updated || '')}`)); loaded = true } catch { /* removed from the lab */ }
  }
  return loaded
}

// ---- the background taken away ----

const cutoutMasks = new Map<string, Canvas>()

/** The cut-out's mask (white = keep) as an alpha mask; decoded once. */
export async function prepareCutout(r: Recipe): Promise<void> {
  const m = r.cutout?.mask
  if (!m || cutoutMasks.has(m)) return
  const res = await fetch(m)
  const bmp = await createImageBitmap(await res.blob())
  const c = makeCanvas(bmp.width, bmp.height)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(bmp, 0, 0)
  const d = g.getImageData(0, 0, c.width, c.height)
  for (let i = 0; i < d.data.length; i += 4) { d.data[i + 3] = d.data[i]; d.data[i] = d.data[i + 1] = d.data[i + 2] = 255 }
  g.putImageData(d, 0, 0)
  if (cutoutMasks.size > 8) cutoutMasks.clear()
  cutoutMasks.set(m, c)
}

function strokeOn(g: CanvasRenderingContext2D, st: BrushStroke, W: number, H: number) {
  const U = Math.min(W, H)
  g.lineWidth = Math.max(1, st.size * U); g.lineCap = 'round'; g.lineJoin = 'round'
  g.beginPath()
  st.points.forEach(([x, y], i) => i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H))
  if (st.points.length === 1) g.lineTo(st.points[0][0] * W + 0.1, st.points[0][1] * H)
  g.stroke()
}

/** Takes the background out of a rendered picture (sw, sh: the original's size). */
export function applyCutout(base: Canvas, sw: number, sh: number, r: Recipe, uncropped: boolean): Canvas {
  const cut = r.cutout
  const mask = cut && cutoutMasks.get(cut.mask)
  if (!cut || !mask) return base
  const W = base.width, H = base.height
  const [cw, ch] = uncropped ? orientedSize(r, sw, sh) : cropSize(r, sw, sh)
  const m = drawGeometry(mask, sw, sh, { ...r, cutout: null }, W / cw, H / ch, uncropped)
  const mg = ctx2d(m)
  if (!uncropped) {
    mg.strokeStyle = '#fff'
    for (const st of cut.keep || []) { mg.globalCompositeOperation = 'source-over'; strokeOn(mg, st, W, H) }
    for (const st of cut.remove || []) { mg.globalCompositeOperation = 'destination-out'; strokeOn(mg, st, W, H) }
  }
  const out = makeCanvas(W, H)
  const g = ctx2d(out)
  if (cut.bg === 'blur') { g.filter = `blur(${Math.max(W, H) / 40}px)`; g.drawImage(base, 0, 0); g.filter = 'none' }
  else if (cut.bg) { g.fillStyle = cut.bg; g.fillRect(0, 0, W, H) }
  const fg = makeCanvas(W, H)
  const fgc = ctx2d(fg)
  fgc.drawImage(base, 0, 0)
  fgc.globalCompositeOperation = 'destination-in'
  if (cut.feather) fgc.filter = `blur(${(cut.feather / 100) * Math.min(W, H) * 0.01}px)`
  fgc.drawImage(m, 0, 0, W, H)
  g.drawImage(fg, 0, 0)
  return out
}

// ---- the frame ----

export interface FrameBox { W: number; H: number; x: number; y: number; w: number; h: number }
const ASPECT: Record<string, number> = { '1:1': 1, '4:5': 4 / 5, '5:4': 5 / 4, '3:2': 3 / 2, '2:3': 2 / 3, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '3:4': 3 / 4 }
/** Where the picture sits inside the frame, and the frame's size. */
export function frameBox(f: Frame | null | undefined, w: number, h: number): FrameBox {
  if (!f) return { W: w, H: h, x: 0, y: 0, w, h }
  const short = Math.min(w, h)
  const b = Math.round((f.width / 100) * short)
  let W = w + 2 * b, H = h + 2 * b
  const ar = ASPECT[f.fit]
  if (ar) {
    const pad = Math.round(((f.pad ?? 6) / 100) * short)
    W = w + 2 * (b + pad); H = h + 2 * (b + pad)
    if (W / H < ar) W = Math.round(H * ar); else H = Math.round(W / ar)
  }
  return { W, H, x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h }
}

export function applyFrame(img: Canvas, f: Frame | null | undefined, transparentOK: boolean): Canvas {
  if (!f || (f.width <= 0 && f.radius <= 0 && (!f.fit || f.fit === 'none'))) return img
  const box = frameBox(f, img.width, img.height)
  const out = makeCanvas(box.W, box.H)
  const g = ctx2d(out)
  const color = f.color || '#ffffff'
  const filled = f.width > 0 || (f.fit && f.fit !== 'none')
  if (f.fill === 'blur' && f.fit && f.fit !== 'none') {
    // the picture itself, enlarged and blurred, behind it
    const k = Math.max(box.W / img.width, box.H / img.height)
    const small = makeCanvas(Math.max(8, box.W / 8), Math.max(8, box.H / 8))
    const sg = ctx2d(small)
    sg.drawImage(img, (small.width - img.width * k / 8) / 2, (small.height - img.height * k / 8) / 2, img.width * k / 8, img.height * k / 8)
    g.filter = `blur(${Math.max(box.W, box.H) / 60}px) brightness(.85)`
    g.drawImage(small, -box.W * 0.05, -box.H * 0.05, box.W * 1.1, box.H * 1.1)
    g.filter = 'none'
  } else if (filled || !transparentOK) {
    g.fillStyle = filled ? color : '#ffffff'
    g.fillRect(0, 0, box.W, box.H)
  }
  if (f.radius > 0) {
    const r = (f.radius / 100) * Math.min(img.width, img.height) * 0.5
    g.save(); g.beginPath(); g.roundRect(box.x, box.y, img.width, img.height, r); g.clip()
    g.drawImage(img, box.x, box.y); g.restore()
  } else g.drawImage(img, box.x, box.y)
  return out
}

// ---- whole renders ----

export interface RenderOpts {
  /** the long edge of the result (before the frame); default: the edit's own size */
  maxEdge?: number
  /** never larger than this many pixels (phones can't make huge canvases) */
  maxArea?: number
  /** draw the whole straightened frame, ignoring the crop (while cropping) */
  uncropped?: boolean
  /** leave out text and drawings (and the frame) */
  noLayers?: boolean
  noFrame?: boolean
  /** skip the pixel step */
  noPixels?: boolean
  /** keep transparency (PNG, WebP) */
  transparent?: boolean
}

/** The picture before text and frame: geometry and the pixel step. */
export async function renderBase(src: CanvasImageSource, sw: number, sh: number, r: Recipe, o: RenderOpts = {}): Promise<Canvas> {
  let [tw, th] = o.uncropped ? orientedSize(r, sw, sh) : imageSize(r, sw, sh)
  const [cw, ch] = o.uncropped ? orientedSize(r, sw, sh) : cropSize(r, sw, sh)
  if (o.maxEdge && Math.max(tw, th) > o.maxEdge) { const k = o.maxEdge / Math.max(tw, th); tw *= k; th *= k }
  if (o.maxArea && tw * th > o.maxArea) { const k = Math.sqrt(o.maxArea / (tw * th)); tw *= k; th *= k }
  const c = drawGeometry(src, sw, sh, r, Math.max(1, Math.round(tw)) / cw, Math.max(1, Math.round(th)) / ch, !!o.uncropped)
  if (o.noPixels) return c
  const p = await runPixels(c, r)
  if (r.cutout) { await prepareCutout(r); return applyCutout(p, sw, sh, r, !!o.uncropped) }
  return p
}

/** Text, drawings and the frame on top of a base picture (a new canvas). */
export function finish(base: Canvas, r: Recipe, o: RenderOpts = {}, skipLayer?: string): Canvas {
  let c = base
  if (!o.noLayers && (r.layers || []).some(l => l.type !== 'redact' && !l.hidden)) {
    c = makeCanvas(base.width, base.height)
    const g = ctx2d(c)
    g.drawImage(base, 0, 0)
    drawLayers(g, r.layers, c.width, c.height, skipLayer)
  }
  if (!o.noFrame && r.frame) c = applyFrame(c, r.frame, !!o.transparent)
  return c
}

export async function render(src: CanvasImageSource, sw: number, sh: number, r: Recipe, o: RenderOpts = {}): Promise<Canvas> {
  const base = await renderBase(src, sw, sh, r, o)
  await prepareLayers(r)
  return finish(base, r, o)
}

export const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' }
export const EXT: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' }

/** Encodes a canvas; JPEG gets a white background under transparent parts. */
export async function encode(c: Canvas, format: string, quality: number, bg = '#ffffff'): Promise<Blob> {
  let src = c
  if (format === 'jpeg') {
    src = makeCanvas(c.width, c.height)
    const g = ctx2d(src)
    g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); g.drawImage(c, 0, 0)
  }
  const blob = await new Promise<Blob | null>(res => src.toBlob(res, MIME[format] || 'image/jpeg', format === 'png' ? undefined : quality))
  if (!blob) throw new Error('the picture is too large for this browser; choose a smaller size')
  if (format !== 'jpeg' && blob.type !== MIME[format]) throw new Error(`this browser cannot save ${format.toUpperCase()}; choose JPEG or PNG`)
  return blob
}

let avifOK: boolean | null = null
export async function canAVIF(): Promise<boolean> {
  if (avifOK !== null) return avifOK
  const b = await new Promise<Blob | null>(res => makeCanvas(2, 2).toBlob(res, 'image/avif', 0.8))
  avifOK = !!b && b.type === 'image/avif'
  return avifOK
}

/** A small JPEG data URL of a canvas (thumbnails for looks and versions, the AI). */
export function dataURL(c: Canvas, edge: number, quality = 0.8): string {
  const k = Math.min(1, edge / Math.max(c.width, c.height))
  const s = makeCanvas(c.width * k, c.height * k)
  const g = ctx2d(s)
  g.fillStyle = '#fff'; g.fillRect(0, 0, s.width, s.height)
  g.imageSmoothingQuality = 'high'
  g.drawImage(c, 0, 0, s.width, s.height)
  return s.toDataURL('image/jpeg', quality)
}

/** The biggest canvas this device makes safely. */
export const MAX_AREA = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 16_000_000 : 120_000_000

export { hexRGB }
