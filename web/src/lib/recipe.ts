// The edit: everything done to a picture, as data. The original is never
// changed; the server keeps this JSON and the browser applies it (render/).
// Positions and sizes of text, shapes and the crop are fractions of the
// picture, so the same edit gives the same result at any size.

export type Pt = [number, number]

export interface Adjust {
  exposure: number; brightness: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number
  temperature: number; tint: number; vibrance: number; saturation: number; hue: number
  clarity: number; dehaze: number; sharpen: number; denoise: number
  vignette: number; grain: number; fade: number; blur: number
}
export type AdjustKey = keyof Adjust

export interface Curves { rgb: Pt[]; r: Pt[]; g: Pt[]; b: Pt[] }
export const BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const
export type Band = typeof BANDS[number]
export const BAND_HUE: Record<Band, number> = { red: 0, orange: 30, yellow: 58, green: 120, aqua: 180, blue: 225, purple: 275, magenta: 320 }
export type HSL = Partial<Record<Band, { h: number; s: number; l: number }>>
export interface Split { sh: number; ss: number; hh: number; hs: number; balance: number }
export interface Effects {
  mono?: boolean; sepia?: number; invert?: boolean; posterize?: number; pixelate?: number
  duotone?: { dark: string; light: string } | null
  tilt?: { y: number; band: number; blur: number } | null
  key?: { color: string; tolerance: number } | null
}
export interface Crop { x: number; y: number; w: number; h: number; aspect?: string }
export interface Frame { width: number; color: string; radius: number; fit: string; fill: 'color' | 'blur'; pad: number }

interface LayerBase { id: string; opacity?: number; hidden?: boolean }
export interface TextLayer extends LayerBase { type: 'text'; x: number; y: number; text: string; font: string; size: number; color: string; bold?: boolean; italic?: boolean; align?: 'left' | 'center' | 'right'; rotate?: number; shadow?: boolean; outline?: string | null; bg?: string | null }
export interface ShapeLayer extends LayerBase { type: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; stroke: string | null; fill: string | null; width: number; radius?: number }
export interface LineLayer extends LayerBase { type: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; stroke: string; width: number }
export interface DrawLayer extends LayerBase { type: 'draw'; points: Pt[]; stroke: string; width: number; marker?: boolean }
export interface StickerLayer extends LayerBase { type: 'sticker'; x: number; y: number; emoji: string; size: number; rotate?: number }
export interface RedactLayer extends LayerBase { type: 'redact'; x: number; y: number; w: number; h: number; mode: 'blur' | 'pixelate' | 'black'; strength: number; round?: boolean }
export interface WatermarkLayer extends LayerBase { type: 'watermark'; text: string; size: number; color: string; tile: boolean; corner: 'br' | 'bl' | 'tr' | 'tl' | 'c' }
export interface ImageLayer extends LayerBase { type: 'image'; x: number; y: number; w: number; aspect: number; src: number; rotate?: number; updated?: string }

// A local adjustment: sliders that act only where the mask is.
interface MaskBase { id: string; name?: string; adjust: Partial<Adjust>; invert?: boolean; hidden?: boolean }
export interface LinearMask extends MaskBase { kind: 'linear'; x1: number; y1: number; x2: number; y2: number }
export interface RadialMask extends MaskBase { kind: 'radial'; x: number; y: number; rx: number; ry: number; feather: number }
export interface BrushStroke { points: Pt[]; size: number; erase?: boolean }
export interface BrushMask extends MaskBase { kind: 'brush'; strokes: BrushStroke[]; feather: number }
export type Mask = LinearMask | RadialMask | BrushMask

// A spot healed or cloned: the area at (x, y) is painted from (sx, sy).
export interface Heal { id: string; x: number; y: number; sx: number; sy: number; r: number; mode: 'heal' | 'clone' }

// The background taken away: a mask the model made (in the original's own
// pixels, so it follows crops and turns), fixed by hand, with what goes behind.
export interface Cutout { mask: string; keep?: BrushStroke[]; remove?: BrushStroke[]; bg: string | null; feather?: number }

export type Layer = ImageLayer | TextLayer | ShapeLayer | LineLayer | DrawLayer | StickerLayer | RedactLayer | WatermarkLayer

export interface Recipe {
  v?: 1
  rotate?: number // 0 | 90 | 180 | 270, clockwise
  flipH?: boolean
  flipV?: boolean
  straighten?: number // degrees, -45…45
  perspective?: { v: number; h: number } | null // keystone, -100…100: buildings upright, a document square
  crop?: Crop | null
  resize?: { w: number; h: number } | null // the finished picture's size, before the frame
  adjust?: Partial<Adjust>
  curves?: Partial<Curves> | null
  hsl?: HSL | null
  split?: Split | null
  look?: { name: string; strength: number } | null
  effects?: Effects | null
  layers?: Layer[]
  masks?: Mask[]
  heals?: Heal[]
  cutout?: Cutout | null
  frame?: Frame | null
}

export const ADJUST_ZERO: Adjust = {
  exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temperature: 0, tint: 0, vibrance: 0, saturation: 0, hue: 0, clarity: 0, dehaze: 0, sharpen: 0, denoise: 0,
  vignette: 0, grain: 0, fade: 0, blur: 0,
}

export interface SliderDef { key: AdjustKey; label: string; min: number; max: number; help?: string; unit?: string }
export const SLIDER_GROUPS: { title: string; icon: string; sliders: SliderDef[] }[] = [
  { title: 'Light', icon: 'sun', sliders: [
    { key: 'exposure', label: 'Exposure', min: -100, max: 100, help: 'Brighter or darker overall, like opening the lens.' },
    { key: 'brightness', label: 'Brightness', min: -100, max: 100, help: 'Lifts or lowers the middle tones.' },
    { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
    { key: 'highlights', label: 'Highlights', min: -100, max: 100, help: 'The bright parts: lower to bring back a white sky.' },
    { key: 'shadows', label: 'Shadows', min: -100, max: 100, help: 'The dark parts: raise to see into them.' },
    { key: 'whites', label: 'Whites', min: -100, max: 100 },
    { key: 'blacks', label: 'Blacks', min: -100, max: 100 },
  ] },
  { title: 'Colour', icon: 'palette', sliders: [
    { key: 'temperature', label: 'Warmth', min: -100, max: 100, help: 'Cooler (blue) or warmer (yellow).' },
    { key: 'tint', label: 'Tint', min: -100, max: 100, help: 'Greener or more magenta.' },
    { key: 'vibrance', label: 'Vibrance', min: -100, max: 100, help: 'More colour where there is little; skin stays natural.' },
    { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
    { key: 'hue', label: 'Hue', min: -180, max: 180, unit: '°', help: 'Turns every colour around the colour wheel.' },
  ] },
  { title: 'Detail', icon: 'focus', sliders: [
    { key: 'clarity', label: 'Clarity', min: -100, max: 100, help: 'Texture and punch in the middle tones.' },
    { key: 'dehaze', label: 'Dehaze', min: -100, max: 100, help: 'Cuts through haze and fog (or adds it).' },
    { key: 'sharpen', label: 'Sharpen', min: 0, max: 100 },
    { key: 'denoise', label: 'Noise reduction', min: 0, max: 100, help: 'Smooths the speckles of a photo taken in the dark.' },
  ] },
  { title: 'Finish', icon: 'sparkles', sliders: [
    { key: 'vignette', label: 'Vignette', min: -100, max: 100, help: 'Darker (or lighter) corners.' },
    { key: 'grain', label: 'Grain', min: 0, max: 100, help: 'Film-like grain.' },
    { key: 'fade', label: 'Fade', min: 0, max: 100, help: 'Washed-out, matte blacks.' },
    { key: 'blur', label: 'Blur', min: 0, max: 100 },
  ] },
]

// ---- looks: ready-made edits, mixed in at a strength ----

export interface LookDef { name: string; label: string; adjust?: Partial<Adjust>; split?: Partial<Split>; mono?: boolean; sepia?: number }
export const LOOKS: LookDef[] = [
  { name: 'vivid', label: 'Vivid', adjust: { vibrance: 40, saturation: 10, contrast: 15, clarity: 10 } },
  { name: 'warm', label: 'Warm', adjust: { temperature: 28, tint: 5, vibrance: 10 } },
  { name: 'cool', label: 'Cool', adjust: { temperature: -28, tint: -4, contrast: 5 } },
  { name: 'golden', label: 'Golden hour', adjust: { temperature: 32, tint: 8, highlights: -12, shadows: 12, vibrance: 15 }, split: { hh: 40, hs: 25 } },
  { name: 'teal-orange', label: 'Teal & orange', adjust: { contrast: 12, saturation: 5 }, split: { sh: 190, ss: 40, hh: 32, hs: 35 } },
  { name: 'film', label: 'Film', adjust: { fade: 22, contrast: -6, grain: 22, saturation: -10 }, split: { sh: 185, ss: 18, hh: 35, hs: 15 } },
  { name: 'fade', label: 'Faded', adjust: { fade: 38, contrast: -15, saturation: -18 } },
  { name: 'matte', label: 'Matte', adjust: { fade: 28, blacks: 18, contrast: -10, vibrance: -5 } },
  { name: 'pastel', label: 'Pastel', adjust: { fade: 18, saturation: -22, exposure: 10, highlights: -22, tint: 6 } },
  { name: 'chrome', label: 'Chrome', adjust: { contrast: 22, saturation: 15, highlights: -15, clarity: 12 } },
  { name: 'dramatic', label: 'Dramatic', adjust: { contrast: 35, clarity: 30, shadows: -10, highlights: -22, vignette: 25, saturation: -10 } },
  { name: 'vintage', label: 'Vintage', adjust: { fade: 20, temperature: 18, vignette: 28, grain: 18, contrast: -5 }, sepia: 25 },
  { name: 'lomo', label: 'Lomo', adjust: { vignette: 55, saturation: 30, contrast: 28 } },
  { name: 'summer', label: 'Summer', adjust: { exposure: 10, temperature: 15, vibrance: 30, highlights: -10 } },
  { name: 'winter', label: 'Winter', adjust: { exposure: 8, temperature: -30, saturation: -20, contrast: 8 } },
  { name: 'night', label: 'Night', adjust: { exposure: -15, temperature: -35, contrast: 20, blacks: -15 } },
  { name: 'mono', label: 'Black & white', adjust: { contrast: 15 }, mono: true },
  { name: 'noir', label: 'Noir', adjust: { contrast: 48, blacks: -22, vignette: 32, clarity: 15 }, mono: true },
  { name: 'silver', label: 'Silver', adjust: { contrast: -8, fade: 15, highlights: -10, brightness: 10 }, mono: true },
  { name: 'sepia', label: 'Sepia', adjust: { contrast: 6 }, sepia: 85 },
]
export const lookByName = (n: string | undefined) => LOOKS.find(l => l.name === n)

/** The sliders in effect: your own plus the look's, at its strength. */
export function effective(r: Recipe): { adjust: Adjust; split: Split | null; mono: boolean; sepia: number } {
  const a: Adjust = { ...ADJUST_ZERO, ...(r.adjust || {}) }
  let split: Split | null = r.split ? { ...r.split } : null
  let mono = !!r.effects?.mono
  let sepia = r.effects?.sepia || 0
  const look = r.look && lookByName(r.look.name)
  if (look) {
    const k = Math.max(0, Math.min(100, r.look!.strength ?? 100)) / 100
    for (const [key, v] of Object.entries(look.adjust || {})) (a as unknown as Record<string, number>)[key] += (v as number) * k
    if (look.split) {
      const s = split || { sh: 0, ss: 0, hh: 0, hs: 0, balance: 0 }
      if (look.split.ss) { s.sh = look.split.sh ?? s.sh; s.ss += look.split.ss * k }
      if (look.split.hs) { s.hh = look.split.hh ?? s.hh; s.hs += look.split.hs * k }
      split = s
    }
    if (look.mono) { if (k >= 0.999) mono = true; else a.saturation -= 100 * k }
    if (look.sepia) sepia = Math.min(100, sepia + look.sepia * k)
  }
  return { adjust: a, split, mono, sepia }
}

// ---- helpers ----

export const isZeroAdjust = (a?: Partial<Adjust>) => !a || Object.values(a).every(v => !v)
const straightCurve = (c?: Pt[]) => !c || c.length < 2 || c.every(([x, y]) => x === y)
export const curvesOn = (c?: Partial<Curves> | null) => !!c && !(straightCurve(c.rgb) && straightCurve(c.r) && straightCurve(c.g) && straightCurve(c.b))
export const hslOn = (h?: HSL | null) => !!h && Object.values(h).some(b => b && (b.h || b.s || b.l))
export const splitOn = (s?: Split | null) => !!s && (s.ss > 0 || s.hs > 0)
export const perspectiveOn = (p?: { v: number; h: number } | null) => !!p && (!!p.v || !!p.h)
export const effectsOn = (e?: Effects | null) => !!e && !!(e.mono || e.sepia || e.invert || e.posterize || e.pixelate || e.duotone || e.tilt || e.key)

/** Whether the pixels themselves change (else the pixel step is skipped). */
export function pixelsChange(r: Recipe): boolean {
  return !isZeroAdjust(r.adjust) || (r.masks || []).some(m => !m.hidden && !isZeroAdjust(m.adjust)) || (r.heals || []).length > 0 || curvesOn(r.curves) || hslOn(r.hsl) || splitOn(r.split) || effectsOn(r.effects) || !!(r.look && r.look.strength > 0) || (r.layers || []).some(l => l.type === 'redact' && !l.hidden)
}

/** Whether the edit changes anything at all. */
export function isEdited(r: Recipe): boolean {
  const c = r.crop
  return pixelsChange(r) || !!(r.rotate && r.rotate % 360) || !!r.flipH || !!r.flipV || !!r.straighten || perspectiveOn(r.perspective) || !!(c && (c.x > 0.0005 || c.y > 0.0005 || c.w < 0.9995 || c.h < 0.9995)) ||
    !!r.resize || (r.layers || []).length > 0 || !!r.cutout || !!(r.frame && (r.frame.width > 0 || r.frame.fit !== 'none' || r.frame.radius > 0))
}

/** Drops empty parts so the stored JSON stays small. */
export function clean(r: Recipe): Recipe {
  const out: Recipe = { v: 1 }
  if (r.rotate && r.rotate % 360) out.rotate = ((r.rotate % 360) + 360) % 360
  if (r.flipH) out.flipH = true
  if (r.flipV) out.flipV = true
  if (r.straighten) out.straighten = Math.round(r.straighten * 10) / 10
  if (perspectiveOn(r.perspective)) out.perspective = r.perspective
  if (r.crop && (r.crop.x > 0.0005 || r.crop.y > 0.0005 || r.crop.w < 0.9995 || r.crop.h < 0.9995)) out.crop = r.crop
  else if (r.crop?.aspect && r.crop.aspect !== 'free') out.crop = { x: 0, y: 0, w: 1, h: 1, aspect: r.crop.aspect }
  if (r.resize) out.resize = r.resize
  if (r.adjust) { const a: Partial<Adjust> = {}; for (const [k, v] of Object.entries(r.adjust)) if (v) (a as Record<string, number>)[k] = Math.round(v as number); if (Object.keys(a).length) out.adjust = a }
  if (curvesOn(r.curves)) out.curves = r.curves
  if (hslOn(r.hsl)) out.hsl = r.hsl
  if (splitOn(r.split)) out.split = r.split
  if (r.look && r.look.name && r.look.strength > 0) out.look = r.look
  if (effectsOn(r.effects)) out.effects = r.effects
  if (r.layers && r.layers.length) out.layers = r.layers
  if (r.masks && r.masks.length) out.masks = r.masks
  if (r.heals && r.heals.length) out.heals = r.heals
  if (r.cutout) out.cutout = r.cutout
  if (r.frame && (r.frame.width > 0 || r.frame.fit !== 'none' || r.frame.radius > 0)) out.frame = r.frame
  return out
}

/** Light, colour and effects only: what a look of your own keeps. */
export function lookPart(r: Recipe): Recipe {
  return clean({ adjust: r.adjust, curves: r.curves, hsl: r.hsl, split: r.split, look: r.look, effects: r.effects ? { ...r.effects, key: null } : null })
}

/** Puts a saved look (your own) on an edit, keeping the crop, text and frame. */
export function applyLook(r: Recipe, look: Recipe): Recipe {
  return { ...r, adjust: look.adjust ? { ...look.adjust } : undefined, curves: look.curves || null, hsl: look.hsl || null, split: look.split || null, look: look.look || null, effects: look.effects ? { ...look.effects, key: r.effects?.key || null } : (r.effects?.key ? { key: r.effects.key } : null) }
}

/** What was done, in a few words, for lists and the Info panel. */
export function describe(r: Recipe): string[] {
  const out: string[] = []
  const c = r.crop
  if (c && (c.w < 0.9995 || c.h < 0.9995)) out.push('cropped' + (c.aspect && c.aspect !== 'free' ? ` (${c.aspect})` : ''))
  if (r.rotate) out.push(`turned ${r.rotate}°`)
  if (r.flipH || r.flipV) out.push('mirrored')
  if (r.straighten) out.push(`straightened ${r.straighten > 0 ? '+' : ''}${r.straighten}°`)
  if (perspectiveOn(r.perspective)) out.push('perspective corrected')
  if (r.resize) out.push(`resized to ${r.resize.w}×${r.resize.h}`)
  const n = Object.values(r.adjust || {}).filter(Boolean).length
  if (n) out.push(`${n} light and colour ${n === 1 ? 'change' : 'changes'}`)
  if (curvesOn(r.curves)) out.push('curves')
  if (hslOn(r.hsl)) out.push('colour mixer')
  if (splitOn(r.split)) out.push('split toning')
  if (r.look?.name) out.push(`${lookByName(r.look.name)?.label || r.look.name} look`)
  if (effectsOn(r.effects)) out.push('effects')
  if (r.masks?.length) out.push(`${r.masks.length} local ${r.masks.length === 1 ? 'adjustment' : 'adjustments'}`)
  if (r.heals?.length) out.push(`${r.heals.length} ${r.heals.length === 1 ? 'spot' : 'spots'} healed`)
  if (r.cutout) out.push('background removed')
  const layers = r.layers || []
  const count = (t: string) => layers.filter(l => l.type === t).length
  if (count('text')) out.push(`${count('text')} text`)
  if (count('draw') + count('rect') + count('ellipse') + count('line') + count('arrow')) out.push('drawing')
  if (count('sticker')) out.push('stickers')
  if (count('redact')) out.push(`${count('redact')} hidden ${count('redact') === 1 ? 'area' : 'areas'}`)
  if (count('watermark')) out.push('watermark')
  if (count('image')) out.push(`${count('image')} ${count('image') === 1 ? 'picture' : 'pictures'} on top`)
  if (r.frame && (r.frame.width > 0 || r.frame.fit !== 'none' || r.frame.radius > 0)) out.push('frame')
  return out
}

export const ASPECTS: { id: string; label: string; ratio: number | null }[] = [
  { id: 'free', label: 'Free', ratio: null }, { id: 'original', label: 'Original', ratio: null },
  { id: '1:1', label: 'Square', ratio: 1 }, { id: '4:5', label: '4:5', ratio: 4 / 5 }, { id: '5:4', label: '5:4', ratio: 5 / 4 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 }, { id: '2:3', label: '2:3', ratio: 2 / 3 }, { id: '4:3', label: '4:3', ratio: 4 / 3 }, { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 }, { id: '9:16', label: '9:16', ratio: 9 / 16 },
]

export const FONTS: { id: string; label: string; css: string }[] = [
  { id: 'sans', label: 'Clean', css: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  { id: 'serif', label: 'Classic', css: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Typewriter', css: 'ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace' },
  { id: 'display', label: 'Poster', css: 'Impact, "Arial Black", "Helvetica Neue", sans-serif' },
  { id: 'hand', label: 'Handwritten', css: '"Bradley Hand", "Segoe Print", "Comic Sans MS", "Marker Felt", cursive' },
  { id: 'round', label: 'Rounded', css: '"SF Pro Rounded", "Arial Rounded MT Bold", "Varela Round", system-ui, sans-serif' },
]
export const fontCSS = (id: string) => id?.startsWith('f:') ? `"plab-font-${id.slice(2)}", system-ui, sans-serif` : (FONTS.find(f => f.id === id) || FONTS[0]).css

export const SWATCHES = ['#ffffff', '#000000', '#f03e3e', '#f76707', '#fab005', '#40c057', '#15aabf', '#4263eb', '#ae3ec9', '#e64980', '#868e96', '#ffe8cc']

export const STICKERS = ['❤️', '⭐', '😀', '😂', '😍', '😎', '🥳', '👍', '👋', '🔥', '✨', '🎉', '🎂', '🎈', '🌸', '🌻', '🌈', '☀️', '🌙', '❄️', '⚡', '💬', '📍', '✅', '❌', '➡️', '⬅️', '⬆️', '⬇️', '💯', '🐶', '🐱', '🏖️', '🏔️', '🍕', '☕', '🍷', '⚽', '🚗', '✈️']

let seq = 0
export const newId = () => `${Date.now().toString(36)}${(seq++).toString(36)}`

export const LOCAL_SLIDERS: AdjustKey[] = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temperature', 'tint', 'saturation', 'clarity', 'dehaze', 'sharpen', 'blur']
