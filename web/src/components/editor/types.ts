import type { Image } from '../../lib/types'
import type { Layer, Recipe } from '../../lib/recipe'

export type Tool = 'crop' | 'adjust' | 'local' | 'color' | 'looks' | 'effects' | 'heal' | 'cutout' | 'text' | 'draw' | 'hide' | 'frame' | 'resize' | 'info'
export type DrawMode = 'brush' | 'marker' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'select'
export interface Brush { color: string; width: number; opacity: number; fill: string | null }
export interface RedactOpts { mode: 'blur' | 'pixelate' | 'black'; strength: number; round: boolean }
/** The brush for local adjustments, healing and fixing a cut-out: size is a fraction of the short side. */
export interface PaintOpts { size: number; erase: boolean; show: boolean; heal: 'heal' | 'clone'; keep: boolean }

/** What every panel and the stage can reach. */
export interface Ed {
  image: Image
  src: ImageBitmap
  recipe: Recipe
  /** change without an undo step (while dragging) */
  set: (r: Recipe) => void
  /** one undo step: with a new edit, or for what set() changed since the last one */
  commit: (r?: Recipe) => void
  /** quick, rougher previews while a slider moves */
  setDraft: (on: boolean) => void
  tool: Tool
  setTool: (t: Tool) => void
  selected: string | null
  select: (id: string | null) => void
  drawMode: DrawMode
  setDrawMode: (m: DrawMode) => void
  brush: Brush
  setBrush: (b: Brush) => void
  redact: RedactOpts
  setRedact: (r: RedactOpts) => void
  paint: PaintOpts
  setPaint: (p: PaintOpts) => void
  /** the size of the rendered picture (without the frame) the stage shows */
  base: { w: number; h: number }
  /** the current look as a canvas (for thumbnails and the AI) */
  view: () => HTMLCanvasElement | null
  updateLayer: (id: string, patch: Partial<Layer>, commit?: boolean) => void
  addLayer: (l: Layer) => void
  removeLayer: (id: string) => void
}
