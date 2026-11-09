// Finding the subject: U²-Net (small, Apache-2.0) run in the browser with
// onnxruntime-web, loaded only when someone takes a background away. The
// answer is a mask in the original's own pixels (white = keep).
import { makeCanvas } from './render/engine'

type Ort = typeof import('onnxruntime-web/wasm')
let ort: Promise<Ort> | null = null
let session: Promise<import('onnxruntime-web/wasm').InferenceSession> | null = null

const SIZE = 320

export async function findSubject(src: ImageBitmap, progress?: (s: string) => void): Promise<string> {
  progress?.('Loading the model…')
  ort ||= import('onnxruntime-web/wasm').then(m => { m.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1; return m })
  const o = await ort
  session ||= o.InferenceSession.create('/models/u2netp.onnx', { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  const s = await session
  progress?.('Finding the subject…')
  const c = makeCanvas(SIZE, SIZE)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(src, 0, 0, SIZE, SIZE)
  const px = g.getImageData(0, 0, SIZE, SIZE).data
  let max = 1
  for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2])
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]
  const input = new Float32Array(3 * SIZE * SIZE)
  for (let i = 0, p = 0; p < SIZE * SIZE; p++, i += 4) for (let ch = 0; ch < 3; ch++) input[ch * SIZE * SIZE + p] = (px[i + ch] / max - mean[ch]) / std[ch]
  const out = await s.run({ [s.inputNames[0]]: new o.Tensor('float32', input, [1, 3, SIZE, SIZE]) })
  const pred = out[s.outputNames[0]].data as Float32Array
  let lo = Infinity, hi = -Infinity
  for (const v of pred) { if (v < lo) lo = v; if (v > hi) hi = v }
  const span = hi - lo || 1
  // the mask, back in the original's shape (at most 768 px on the long side)
  const k = Math.min(1, 768 / Math.max(src.width, src.height))
  const mw = Math.max(16, Math.round(src.width * k)), mh = Math.max(16, Math.round(src.height * k))
  const small = makeCanvas(SIZE, SIZE)
  const sg = small.getContext('2d')!
  const md = sg.createImageData(SIZE, SIZE)
  for (let p = 0; p < SIZE * SIZE; p++) {
    let v = (pred[p] - lo) / span
    v = Math.max(0, Math.min(1, (v - 0.08) / 0.84)) // a crisper edge
    const b = Math.round(v * 255)
    md.data[p * 4] = md.data[p * 4 + 1] = md.data[p * 4 + 2] = b; md.data[p * 4 + 3] = 255
  }
  sg.putImageData(md, 0, 0)
  const m = makeCanvas(mw, mh)
  const mg = m.getContext('2d')!
  mg.imageSmoothingQuality = 'high'
  mg.drawImage(small, 0, 0, mw, mh)
  return m.toDataURL('image/png')
}
