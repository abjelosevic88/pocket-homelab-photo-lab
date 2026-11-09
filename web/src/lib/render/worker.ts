// Runs the pixel step off the main thread so sliders stay smooth.
import { process } from './pixels'
import type { Recipe } from '../recipe'

interface Job { id: number; w: number; h: number; buf: ArrayBuffer; recipe: Recipe }

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, w, h, buf, recipe } = e.data
  try {
    process(new Uint8ClampedArray(buf), w, h, recipe)
    ;(self as unknown as Worker).postMessage({ id, buf }, [buf])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message || err) })
  }
}
