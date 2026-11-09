// The pixel step: light, colour, detail, effects and hidden areas, on RGBA
// bytes. Pure functions, run in a worker (worker.ts) for the editor and
// directly for small thumbnails. Every radius is a fraction of the picture,
// so a small preview and the full-size export look the same.

import { BAND_HUE, BANDS, effective, curvesOn, hslOn, isZeroAdjust, type BrushStroke, type Heal, type Mask, type Pt, type Recipe, type RedactLayer } from '../recipe'

const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v)
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t) }

export function hexRGB(hex: string): [number, number, number] {
  let h = (hex || '#000').replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h.slice(0, 6), 16) || 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hueRGB(h: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h / 30) % 12; return 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
  return [f(0), f(8), f(4)]
}

/** A monotone curve through the points, as a 256-entry table (Fritsch–Carlson). */
export function curveTable(pts: Pt[] | undefined): Float32Array | null {
  if (!pts || pts.length < 2 || pts.every(([x, y]) => x === y)) return null
  const p = [...pts].sort((a, b) => a[0] - b[0])
  const n = p.length
  const xs = p.map(q => q[0]), ys = p.map(q => q[1])
  const d: number[] = [], m: number[] = new Array(n).fill(0)
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]))
  m[0] = d[0]; m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i] }
  }
  const out = new Float32Array(256)
  let k = 0
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) { out[x] = ys[0]; continue }
    if (x >= xs[n - 1]) { out[x] = ys[n - 1]; continue }
    while (k < n - 2 && x > xs[k + 1]) k++
    const h = xs[k + 1] - xs[k], t = (x - xs[k]) / h
    const t2 = t * t, t3 = t2 * t
    out[x] = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1]
  }
  return out
}

/** The tone curve (exposure, whites/blacks, highlights/shadows, contrast, brightness, fade) for one value 0…1. */
function toneFn(a: ReturnType<typeof effective>['adjust']) {
  const ev = Math.pow(2, (a.exposure / 100) * 2)
  const black = (-a.blacks / 100) * 0.12, white = 1 - (a.whites / 100) * 0.15
  const sh = a.shadows / 100, hi = a.highlights / 100
  const c = a.contrast / 100
  const kc = c > 0 ? 1 + c * 4 : 0
  const tk = kc ? Math.tanh(kc * 0.5) : 1
  const bright = Math.pow(2, -a.brightness / 100 * 0.9)
  const fade = a.fade / 100
  return (x: number) => {
    if (ev !== 1) x = Math.pow(Math.pow(x, 2.2) * ev, 1 / 2.2)
    x = (x - black) / Math.max(0.05, white - black)
    x = clamp(x, 0, 1.5)
    if (sh) x += sh * 0.6 * x * (1 - x) * (1 - x) * (sh > 0 ? 1.7 : 1.2)
    if (hi) x += hi * 0.6 * x * x * (1 - x) * (hi > 0 ? 1.2 : 1.7)
    x = clamp(x)
    if (c > 0) x = 0.5 + (0.5 * Math.tanh(kc * (x - 0.5))) / tk
    else if (c < 0) x = 0.5 + (x - 0.5) * (1 + c * 0.75)
    if (bright !== 1) x = Math.pow(clamp(x), bright)
    if (fade) x = fade * 0.22 + x * (1 - fade * 0.22 - fade * 0.07)
    return clamp(x)
  }
}

// ---- blurs: three box passes ≈ a Gaussian, O(1) per pixel whatever the radius ----

function boxesForGauss(sigma: number): number[] {
  const n = 3
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1)
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--
  const wu = wl + 2
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4)
  const m = Math.round(mIdeal)
  return Array.from({ length: n }, (_, i) => ((i < m ? wl : wu) - 1) / 2)
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const iarr = 1 / (r + r + 1)
  for (let y = 0; y < h; y++) {
    let ti = y * w, li = ti, ri = ti + r
    const fv = src[ti], lv = src[ti + w - 1]
    let val = (r + 1) * fv
    for (let j = 0; j < r; j++) val += src[ti + j]
    for (let j = 0; j <= r; j++) { val += src[ri++] - fv; dst[ti++] = val * iarr }
    for (let j = r + 1; j < w - r; j++) { val += src[ri++] - src[li++]; dst[ti++] = val * iarr }
    for (let j = w - r; j < w; j++) { val += lv - src[li++]; dst[ti++] = val * iarr }
  }
}
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const iarr = 1 / (r + r + 1)
  for (let x = 0; x < w; x++) {
    let ti = x, li = ti, ri = ti + r * w
    const fv = src[ti], lv = src[ti + w * (h - 1)]
    let val = (r + 1) * fv
    for (let j = 0; j < r; j++) val += src[ti + j * w]
    for (let j = 0; j <= r; j++) { val += src[ri] - fv; dst[ti] = val * iarr; ri += w; ti += w }
    for (let j = r + 1; j < h - r; j++) { val += src[ri] - src[li]; dst[ti] = val * iarr; li += w; ri += w; ti += w }
    for (let j = h - r; j < h; j++) { val += lv - src[li]; dst[ti] = val * iarr; li += w; ti += w }
  }
}

/** Gaussian blur of one plane, in place. */
export function gaussPlane(p: Float32Array, w: number, h: number, sigma: number) {
  if (sigma < 0.4 || w < 2 || h < 2) return
  const tmp = new Float32Array(p.length)
  for (const b of boxesForGauss(sigma)) {
    const r = Math.round(b)
    const rh = Math.min(r, Math.floor((w - 1) / 2)), rv = Math.min(r, Math.floor((h - 1) / 2))
    if (rh >= 1) boxH(p, tmp, w, h, rh); else tmp.set(p)
    if (rv >= 1) boxV(tmp, p, w, h, rv); else p.set(tmp)
  }
}

function planes(px: Uint8ClampedArray, n: number): [Float32Array, Float32Array, Float32Array] {
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) { r[i] = px[j]; g[i] = px[j + 1]; b[i] = px[j + 2] }
  return [r, g, b]
}
function lumaPlane(px: Uint8ClampedArray, n: number): Float32Array {
  const l = new Float32Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) l[i] = 0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2]
  return l
}

/** Blurs a rectangle of the picture (used for hidden areas and tilt-shift masks). */
function blurRegion(px: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number, sigma: number) {
  const rw = x1 - x0, rh = y1 - y0
  if (rw < 2 || rh < 2) return
  const n = rw * rh
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const j = ((y + y0) * w + x + x0) * 4, i = y * rw + x; ch[0][i] = px[j]; ch[1][i] = px[j + 1]; ch[2][i] = px[j + 2] }
  for (const c of ch) { gaussPlane(c, rw, rh, sigma); gaussPlane(c, rw, rh, sigma * 0.6) }
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const j = ((y + y0) * w + x + x0) * 4, i = y * rw + x; px[j] = ch[0][i]; px[j + 1] = ch[1][i]; px[j + 2] = ch[2][i] }
}

function pixelateRegion(px: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number, block: number, mask?: (x: number, y: number) => boolean) {
  block = Math.max(2, Math.round(block))
  for (let by = y0; by < y1; by += block) {
    for (let bx = x0; bx < x1; bx += block) {
      const ex = Math.min(bx + block, x1), ey = Math.min(by + block, y1)
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const j = (y * w + x) * 4; r += px[j]; g += px[j + 1]; b += px[j + 2]; a += px[j + 3]; n++ }
      r /= n; g /= n; b /= n; a /= n
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { if (mask && !mask(x, y)) continue; const j = (y * w + x) * 4; px[j] = r; px[j + 1] = g; px[j + 2] = b; px[j + 3] = a }
    }
  }
}

/** Deterministic noise in -1…1 for a cell. */
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) & 0xffff) / 32767.5 - 1
}

/** Applies the pixel part of an edit to RGBA bytes of a w×h picture, in place. */
export function process(px: Uint8ClampedArray, w: number, h: number, r: Recipe): void {
  const n = w * h
  const unit = Math.max(w, h)
  const eff = effective(r)
  const a = eff.adjust

  // 1. white balance, tone and curves as one table per channel
  const temp = a.temperature / 100, tint = a.tint / 100
  const mulR = 1 + temp * 0.22 + tint * 0.06, mulG = 1 - tint * 0.18, mulB = 1 - temp * 0.26 + tint * 0.06
  const tone = toneFn(a)
  const master = curveTable(r.curves?.rgb), cr = curveTable(r.curves?.r), cg = curveTable(r.curves?.g), cb = curveTable(r.curves?.b)
  const lut = (mul: number, ch: Float32Array | null) => {
    const t = new Uint8ClampedArray(1024)
    for (let i = 0; i < 1024; i++) {
      let v = tone(clamp((i / 1023) * mul)) * 255
      if (master) v = master[Math.round(clamp(v, 0, 255))]
      if (ch) v = ch[Math.round(clamp(v, 0, 255))]
      t[i] = v
    }
    return t
  }
  const toneOn = a.exposure || a.brightness || a.contrast || a.highlights || a.shadows || a.whites || a.blacks || a.fade || temp || tint || curvesOn(r.curves)
  if (toneOn) {
    const lr = lut(mulR, cr), lg = lut(mulG, cg), lb = lut(mulB, cb)
    for (let j = 0; j < n * 4; j += 4) { px[j] = lr[(px[j] * 4.0118) | 0]; px[j + 1] = lg[(px[j + 1] * 4.0118) | 0]; px[j + 2] = lb[(px[j + 2] * 4.0118) | 0] }
  }

  // 2. dehaze: take the haze (the darkest channel's average) out and stretch back
  if (a.dehaze) {
    let sum = 0, cnt = 0
    for (let j = 0; j < n * 4; j += 64) { sum += Math.min(px[j], px[j + 1], px[j + 2]); cnt++ }
    const airlight = sum / Math.max(1, cnt)
    const d = (a.dehaze / 100) * 0.75
    if (d > 0) {
      const k = 1 / (1 - d * airlight / 255)
      for (let j = 0; j < n * 4; j += 4) for (let c = 0; c < 3; c++) px[j + c] = (px[j + c] - d * airlight) * k
    } else {
      for (let j = 0; j < n * 4; j += 4) for (let c = 0; c < 3; c++) px[j + c] = px[j + c] * (1 + d * 0.6) - d * 0.6 * 215
    }
  }

  // 3. colour: vibrance, saturation, hue, the colour mixer, split toning
  const sat = 1 + a.saturation / 100 + (a.dehaze > 0 ? a.dehaze / 400 : 0)
  const vib = a.vibrance / 100
  const hueOn = !!a.hue
  let hm: number[] = []
  if (hueOn) {
    const th = (a.hue * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th)
    hm = [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]
  }
  const mixer = hslOn(r.hsl) ? BANDS.map(b => ({ hue: BAND_HUE[b], ...(r.hsl?.[b] || { h: 0, s: 0, l: 0 }) })).filter(b => b.h || b.s || b.l) : null
  const split = eff.split && (eff.split.ss > 0 || eff.split.hs > 0) ? eff.split : null
  const sc = split ? hueRGB(split.sh) : [0, 0, 0], hc = split ? hueRGB(split.hh) : [0, 0, 0]
  const pivot = split ? 0.5 + (split.balance || 0) / 250 : 0.5
  if (sat !== 1 || vib || hueOn || mixer || split) {
    for (let j = 0; j < n * 4; j += 4) {
      let R = px[j], G = px[j + 1], B = px[j + 2]
      if (hueOn) { const r2 = hm[0] * R + hm[1] * G + hm[2] * B, g2 = hm[3] * R + hm[4] * G + hm[5] * B, b2 = hm[6] * R + hm[7] * G + hm[8] * B; R = r2; G = g2; B = b2 }
      if (mixer) {
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn
        if (d > 2) {
          let hh: number
          if (mx === R) hh = ((G - B) / d) % 6; else if (mx === G) hh = (B - R) / d + 2; else hh = (R - G) / d + 4
          hh *= 60; if (hh < 0) hh += 360
          let dh = 0, ds = 0, dl = 0
          for (const b of mixer) {
            let dist = Math.abs(hh - b.hue); if (dist > 180) dist = 360 - dist
            const wgt = dist >= 45 ? 0 : Math.cos((dist / 45) * Math.PI / 2) ** 2
            if (wgt) { dh += b.h * wgt; ds += b.s * wgt; dl += b.l * wgt }
          }
          if (dh || ds || dl) {
            const l = (mx + mn) / 510
            let s = d / 255 / (1 - Math.abs(2 * l - 1) || 1)
            let L = l
            const H = (hh + dh * 0.3 + 360) % 360
            s = clamp(s * (1 + ds / 100)); L = clamp(L + (dl / 100) * 0.25 * s)
            const C = (1 - Math.abs(2 * L - 1)) * s, X = C * (1 - Math.abs(((H / 60) % 2) - 1)), m = L - C / 2
            let r1 = 0, g1 = 0, b1 = 0
            if (H < 60) { r1 = C; g1 = X } else if (H < 120) { r1 = X; g1 = C } else if (H < 180) { g1 = C; b1 = X } else if (H < 240) { g1 = X; b1 = C } else if (H < 300) { r1 = X; b1 = C } else { r1 = C; b1 = X }
            R = (r1 + m) * 255; G = (g1 + m) * 255; B = (b1 + m) * 255
          }
        }
      }
      const L = 0.2126 * R + 0.7152 * G + 0.0722 * B
      let k = sat
      if (vib) { const mx = Math.max(R, G, B), mn = Math.min(R, G, B); const cur = mx ? (mx - mn) / mx : 0; k *= 1 + vib * (1 - cur) * (vib > 0 ? 1.3 : 1) }
      if (k !== 1) { R = L + (R - L) * k; G = L + (G - L) * k; B = L + (B - L) * k }
      if (split) {
        const l = L / 255
        const ws = smooth(pivot, 0, l) * (split.ss / 100) * 0.35, wh = smooth(pivot, 1, l) * (split.hs / 100) * 0.35
        if (ws) { R += (sc[0] * 255 - 127.5) * ws; G += (sc[1] * 255 - 127.5) * ws; B += (sc[2] * 255 - 127.5) * ws }
        if (wh) { R += (hc[0] * 255 - 127.5) * wh; G += (hc[1] * 255 - 127.5) * wh; B += (hc[2] * 255 - 127.5) * wh }
      }
      px[j] = R; px[j + 1] = G; px[j + 2] = B
    }
  }

  // 4. detail: clarity (big-radius local contrast), sharpen, noise reduction
  if (a.clarity) {
    const l = lumaPlane(px, n), bl = l.slice()
    gaussPlane(bl, w, h, unit * 0.012)
    const amt = (a.clarity / 100) * 0.9
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const v = l[i] / 255, mid = 1 - (2 * v - 1) ** 2
      const d = (l[i] - bl[i]) * amt * mid
      px[j] += d; px[j + 1] += d; px[j + 2] += d
    }
  }
  if (a.denoise) {
    const [pr, pg, pb] = planes(px, n)
    const sig = Math.max(0.6, unit * 0.0011 * (0.5 + a.denoise / 100))
    gaussPlane(pr, w, h, sig); gaussPlane(pg, w, h, sig); gaussPlane(pb, w, h, sig)
    const thr = 6 + (a.denoise / 100) * 26
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const d = Math.abs(px[j] - pr[i]) + Math.abs(px[j + 1] - pg[i]) + Math.abs(px[j + 2] - pb[i])
      const t = clamp(1 - d / (3 * thr)) * (0.4 + (a.denoise / 100) * 0.6)
      px[j] += (pr[i] - px[j]) * t; px[j + 1] += (pg[i] - px[j + 1]) * t; px[j + 2] += (pb[i] - px[j + 2]) * t
    }
  }
  if (a.sharpen) {
    const l = lumaPlane(px, n), bl = l.slice()
    gaussPlane(bl, w, h, Math.max(0.7, unit * 0.0007))
    const amt = (a.sharpen / 100) * 1.6
    for (let i = 0, j = 0; i < n; i++, j += 4) { const d = (l[i] - bl[i]) * amt; px[j] += d; px[j + 1] += d; px[j + 2] += d }
  }

  // 5. blur and tilt-shift
  const fx = r.effects || {}
  if (a.blur > 0 || fx.tilt) {
    const sigma = a.blur > 0 ? unit * 0.02 * (a.blur / 100) : unit * 0.012 * ((fx.tilt?.blur ?? 50) / 100)
    const orig = fx.tilt && !(a.blur > 0) ? px.slice() : null
    const [pr, pg, pb] = planes(px, n)
    gaussPlane(pr, w, h, sigma); gaussPlane(pg, w, h, sigma); gaussPlane(pb, w, h, sigma)
    for (let i = 0, j = 0; i < n; i++, j += 4) { px[j] = pr[i]; px[j + 1] = pg[i]; px[j + 2] = pb[i] }
    if (orig && fx.tilt) {
      const cy = fx.tilt.y, half = Math.max(0.02, fx.tilt.band / 2)
      for (let y = 0; y < h; y++) {
        const t = smooth(half, half + 0.18, Math.abs(y / h - cy))
        for (let x = 0; x < w; x++) { const j = (y * w + x) * 4; for (let c = 0; c < 3; c++) px[j + c] = orig[j + c] + (px[j + c] - orig[j + c]) * t }
      }
    }
  }

  // 6. effects
  const mono = eff.mono, sepia = eff.sepia / 100
  const duo = fx.duotone ? [hexRGB(fx.duotone.dark), hexRGB(fx.duotone.light)] : null
  const post = fx.posterize && fx.posterize >= 2 ? Math.round(fx.posterize) : 0
  if (mono || sepia || duo || fx.invert || post) {
    const step = post ? 255 / (post - 1) : 0
    for (let j = 0; j < n * 4; j += 4) {
      let R = px[j], G = px[j + 1], B = px[j + 2]
      if (mono || duo) { const L = 0.2126 * R + 0.7152 * G + 0.0722 * B; R = G = B = L }
      if (duo) { const t = R / 255; R = duo[0][0] + (duo[1][0] - duo[0][0]) * t; G = duo[0][1] + (duo[1][1] - duo[0][1]) * t; B = duo[0][2] + (duo[1][2] - duo[0][2]) * t }
      if (sepia) {
        const sr = 0.393 * R + 0.769 * G + 0.189 * B, sg = 0.349 * R + 0.686 * G + 0.168 * B, sb = 0.272 * R + 0.534 * G + 0.131 * B
        R += (sr - R) * sepia; G += (sg - G) * sepia; B += (sb - B) * sepia
      }
      if (fx.invert) { R = 255 - R; G = 255 - G; B = 255 - B }
      if (post) { R = Math.round(clamp(R, 0, 255) / step) * step; G = Math.round(clamp(G, 0, 255) / step) * step; B = Math.round(clamp(B, 0, 255) / step) * step }
      px[j] = R; px[j + 1] = G; px[j + 2] = B
    }
  }
  if (fx.pixelate && fx.pixelate > 0) pixelateRegion(px, w, 0, 0, w, h, Math.max(2, unit * 0.04 * (fx.pixelate / 100)))
  if (fx.key) {
    const [kr, kg, kb] = hexRGB(fx.key.color)
    const tol = 8 + (fx.key.tolerance / 100) * 180, soft = tol * 0.35
    for (let j = 0; j < n * 4; j += 4) {
      const d = Math.sqrt((px[j] - kr) ** 2 + (px[j + 1] - kg) ** 2 + (px[j + 2] - kb) ** 2)
      if (d < tol + soft) px[j + 3] = Math.min(px[j + 3], 255 * smooth(tol - soft, tol + soft, d))
    }
  }

  // 7. vignette and grain
  if (a.vignette) {
    const v = a.vignette / 100
    const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2
    for (let y = 0; y < h; y++) {
      const dy = (y - cy) / ry
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / rx
        const m = smooth(0.45, 1.45, Math.sqrt(dx * dx + dy * dy)) * Math.abs(v) * 0.85
        if (!m) continue
        const j = (y * w + x) * 4
        if (v > 0) { const k = 1 - m; px[j] *= k; px[j + 1] *= k; px[j + 2] *= k } else { px[j] += (255 - px[j]) * m; px[j + 1] += (255 - px[j + 1]) * m; px[j + 2] += (255 - px[j + 2]) * m }
      }
    }
  }
  if (a.grain > 0) {
    const g = (a.grain / 100) * 42
    const cell = Math.max(1, unit / 1600)
    for (let y = 0; y < h; y++) {
      const gy = Math.floor(y / cell)
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4
        const L = (px[j] + px[j + 1] + px[j + 2]) / 765
        const d = hash(Math.floor(x / cell), gy) * g * (0.35 + 0.65 * (1 - Math.abs(2 * L - 1)))
        px[j] += d; px[j + 1] += d; px[j + 2] += d
      }
    }
  }

  // 8. local adjustments: the same steps on a copy, kept where the mask is
  for (const m of r.masks || []) {
    if (m.hidden || isZeroAdjust(m.adjust)) continue
    const plane = maskPlane(m, w, h)
    const tmp = px.slice()
    process(tmp, w, h, { adjust: m.adjust })
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const k = plane[i]
      if (k <= 0) continue
      px[j] += (tmp[j] - px[j]) * k; px[j + 1] += (tmp[j + 1] - px[j + 1]) * k; px[j + 2] += (tmp[j + 2] - px[j + 2]) * k
    }
  }

  // 9. healed and cloned spots
  if (r.heals?.length) heal(px, w, h, r.heals)

  // 10. hidden areas
  for (const l of (r.layers || []) as RedactLayer[]) {
    if (l.type !== 'redact' || l.hidden) continue
    const x0 = Math.max(0, Math.floor(l.x * w)), y0 = Math.max(0, Math.floor(l.y * h))
    const x1 = Math.min(w, Math.ceil((l.x + l.w) * w)), y1 = Math.min(h, Math.ceil((l.y + l.h) * h))
    if (x1 - x0 < 1 || y1 - y0 < 1) continue
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2
    const inside = l.round ? (x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 : undefined
    const strength = (l.strength ?? 60) / 100
    if (l.mode === 'black') {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (inside && !inside(x, y)) continue; const j = (y * w + x) * 4; px[j] = px[j + 1] = px[j + 2] = 0 }
    } else if (l.mode === 'pixelate') {
      pixelateRegion(px, w, x0, y0, x1, y1, Math.max(4, Math.min(x1 - x0, y1 - y0) * (0.06 + strength * 0.2)), inside)
    } else {
      // blur with some of the surroundings (so edges don't smear in from black),
      // then keep the result only inside the area
      const pad = Math.ceil(unit * 0.02)
      const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad), bx1 = Math.min(w, x1 + pad), by1 = Math.min(h, y1 + pad)
      const bw = bx1 - bx0
      const saved = new Uint8ClampedArray(bw * (by1 - by0) * 4)
      for (let y = by0; y < by1; y++) saved.set(px.subarray((y * w + bx0) * 4, (y * w + bx1) * 4), (y - by0) * bw * 4)
      blurRegion(px, w, bx0, by0, bx1, by1, Math.max(2, unit * 0.008 * (0.5 + strength * 2.5)))
      for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
        if (x >= x0 && x < x1 && y >= y0 && y < y1 && (!inside || inside(x, y))) continue
        const j = (y * w + x) * 4, k = ((y - by0) * bw + (x - bx0)) * 4
        px[j] = saved[k]; px[j + 1] = saved[k + 1]; px[j + 2] = saved[k + 2]; px[j + 3] = saved[k + 3]
      }
    }
  }
}

/** Sizes for the histogram: counts per value for r, g, b and luminance. */
export function histogram(px: Uint8ClampedArray, step = 4): { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array } {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256)
  for (let j = 0; j < px.length; j += 4 * step) {
    if (px[j + 3] < 8) continue
    r[px[j]]++; g[px[j + 1]]++; b[px[j + 2]]++
    l[Math.round(0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2])]++
  }
  return { r, g, b, l }
}

/** "Auto": levels and white balance from the picture itself. */
export function autoAdjust(px: Uint8ClampedArray): { exposure: number; whites: number; blacks: number; temperature: number; tint: number; vibrance: number; contrast: number } {
  const { l } = histogram(px, 2)
  let total = 0
  for (const v of l) total += v
  const pct = (p: number) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += l[i]; if (acc >= total * p) return i } return 255 }
  const lo = pct(0.005), hi = pct(0.995), mid = pct(0.5)
  let sr = 0, sg = 0, sb = 0, cnt = 0
  for (let j = 0; j < px.length; j += 32) {
    const L = 0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2]
    if (L < 40 || L > 230) continue
    sr += px[j]; sg += px[j + 1]; sb += px[j + 2]; cnt++
  }
  const round = (v: number, lim = 60) => Math.round(Math.max(-lim, Math.min(lim, v)))
  let temperature = 0, tint = 0
  if (cnt > 50) {
    sr /= cnt; sg /= cnt; sb /= cnt
    temperature = round(((sb - sr) / Math.max(1, (sr + sb) / 2)) * 160, 45)
    tint = round(((sg - (sr + sb) / 2) / Math.max(1, sg)) * 140, 30)
  }
  return {
    blacks: round(-lo / 255 * 100 / 0.12 * 0.6, 40), whites: round((255 - hi) / 255 * 100 / 0.15 * 0.6, 40),
    exposure: round((0.46 - mid / 255) * 90, 45), temperature, tint, vibrance: 12, contrast: 6,
  }
}

/** Where a local adjustment acts, 0…1 per pixel. */
export function maskPlane(m: Mask, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  const U = Math.min(w, h)
  if (m.kind === 'linear') {
    const x1 = m.x1 * w, y1 = m.y1 * h, dx = m.x2 * w - x1, dy = m.y2 * h - y1
    const len2 = Math.max(1, dx * dx + dy * dy)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = ((x - x1) * dx + (y - y1) * dy) / len2
      out[y * w + x] = 1 - smooth(0, 1, t)
    }
  } else if (m.kind === 'radial') {
    const cx = m.x * w, cy = m.y * h, rx = Math.max(1, m.rx * w), ry = Math.max(1, m.ry * h)
    const f = Math.max(0.02, Math.min(1, (m.feather ?? 50) / 100))
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2)
      out[y * w + x] = 1 - smooth(1 - f, 1, d)
    }
  } else {
    const f = Math.max(0.02, Math.min(1, (m.feather ?? 50) / 100))
    for (const st of m.strokes) paintStroke(out, w, h, st, U, f)
  }
  if (m.invert) for (let i = 0; i < out.length; i++) out[i] = 1 - out[i]
  return out
}

/** Paints (or with erase, takes away) a soft round brush along a stroke. */
export function paintStroke(out: Float32Array, w: number, h: number, st: BrushStroke, U: number, feather: number) {
  const r = Math.max(1, (st.size * U) / 2)
  const pts = st.points.map(([x, y]) => [x * w, y * h])
  if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1]])
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1]
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r))
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r))
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2))
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) / r
      if (d >= 1) continue
      const v = 1 - smooth(1 - feather, 1, d)
      const k = y * w + x
      out[k] = st.erase ? Math.min(out[k], 1 - v) : Math.max(out[k], v)
    }
  }
}

function ringMean(px: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, r0: number, r1: number): [number, number, number] {
  let R = 0, G = 0, B = 0, n = 0
  const x0 = Math.max(0, Math.floor(cx - r1)), x1 = Math.min(w - 1, Math.ceil(cx + r1)), y0 = Math.max(0, Math.floor(cy - r1)), y1 = Math.min(h - 1, Math.ceil(cy + r1))
  const step = Math.max(1, Math.floor((r1 - r0) / 3))
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
    const d = Math.hypot(x - cx, y - cy)
    if (d < r0 || d > r1) continue
    const j = (y * w + x) * 4
    R += px[j]; G += px[j + 1]; B += px[j + 2]; n++
  }
  return n ? [R / n, G / n, B / n] : [0, 0, 0]
}

/** Paints each spot from its source; "heal" also matches the colour around it. */
export function heal(px: Uint8ClampedArray, w: number, h: number, spots: Heal[]) {
  const U = Math.min(w, h)
  for (const s of spots) {
    const r = Math.max(1.5, s.r * U)
    const cx = s.x * w, cy = s.y * h, sx = s.sx * w, sy = s.sy * h
    let dR = 0, dG = 0, dB = 0
    if (s.mode === 'heal') {
      const t = ringMean(px, w, h, cx, cy, r, r * 1.35), o = ringMean(px, w, h, sx, sy, r, r * 1.35)
      dR = t[0] - o[0]; dG = t[1] - o[1]; dB = t[2] - o[2]
    }
    const src = px.slice()
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / r
      if (d >= 1) continue
      const a = 1 - smooth(s.mode === 'heal' ? 0.45 : 0.75, 1, d)
      const fx = Math.round(x - cx + sx), fy = Math.round(y - cy + sy)
      if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue
      const j = (y * w + x) * 4, k = (fy * w + fx) * 4
      px[j] += (src[k] + dR - px[j]) * a; px[j + 1] += (src[k + 1] + dG - px[j + 1]) * a; px[j + 2] += (src[k + 2] + dB - px[j + 2]) * a
    }
  }
}

/** Picks where to heal a spot from: the nearby patch whose surroundings look most like the spot's. */
export function bestSource(px: Uint8ClampedArray, w: number, h: number, x: number, y: number, r: number): [number, number] {
  const U = Math.min(w, h), rr = Math.max(2, r * U), cx = x * w, cy = y * h
  const target = ringMean(px, w, h, cx, cy, rr, rr * 1.4)
  let best: [number, number] = [x + (2.2 * rr) / w, y], bestD = Infinity
  for (let k = 0; k < 16; k++) {
    const ang = (k / 16) * Math.PI * 2, dist = rr * (k % 2 ? 2.2 : 3.2)
    const sx = cx + Math.cos(ang) * dist, sy = cy + Math.sin(ang) * dist
    if (sx - rr < 0 || sy - rr < 0 || sx + rr >= w || sy + rr >= h) continue
    const m = ringMean(px, w, h, sx, sy, 0, rr * 1.4)
    const d = (m[0] - target[0]) ** 2 + (m[1] - target[1]) ** 2 + (m[2] - target[2]) ** 2
    if (d < bestD) { bestD = d; best = [sx / w, sy / h] }
  }
  return best
}
