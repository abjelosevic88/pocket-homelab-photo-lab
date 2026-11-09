// Choosing pictures: from Pocket Photos, from Pocket Files, or already in the lab.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import type { FileEntry, Image, ImportResult, PhotoItem, Space } from '../lib/types'
import { thumbURL } from '../lib/images'
import { fmtDate } from '../lib/format'
import { Icon } from './icons'
import { Select } from './Select'
import { Loading, Modal, Spinner, useDebounce, useToast, errMsg } from './ui'

function NotConnected({ app, error, onClose }: { app: string; error: string; onClose: () => void }) {
  return (
    <div className="picker-empty">
      <Icon name="link" size={22} />
      <p><b>{app} is not connected.</b></p>
      <p className="muted small">{error}</p>
      <Link to="/settings/apps" className="btn" onClick={onClose}><Icon name="settings" size={15} />Settings → Connected apps</Link>
    </div>
  )
}

function Check({ on }: { on: boolean }) {
  return <span className={`pick-check ${on ? 'on' : ''}`} aria-hidden="true">{on && <Icon name="check" size={14} strokeWidth={2.6} />}</span>
}

export function PhotosPicker({ onClose, onDone }: { onClose: () => void; onDone: (r: ImportResult) => void }) {
  const { toast } = useToast()
  const [q, setQ] = useState('')
  const dq = useDebounce(q, 450)
  const [favs, setFavs] = useState(false)
  const [items, setItems] = useState<PhotoItem[]>([])
  const [next, setNext] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notConnected, setNotConnected] = useState('')
  const [sel, setSel] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const gen = useRef(0)
  const load = useCallback(async (cursor = '') => {
    const g = ++gen.current
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams({ q: dq.trim(), cursor, favorites: favs ? '1' : '' })
      const r = await api.get<{ items: PhotoItem[]; next: string }>(`${V1}/sources/photos?${p}`)
      if (g !== gen.current) return
      setItems(old => cursor ? [...old, ...r.items.filter(i => !old.some(o => o.id === i.id))] : r.items)
      setNext(dq.trim() ? '' : r.next)
    } catch (e) {
      if (g !== gen.current) return
      const st = (e as { status?: number }).status
      if (st === 409) setNotConnected(errMsg(e)); else setError(errMsg(e))
    } finally { if (g === gen.current) setLoading(false) }
  }, [dq, favs])
  useEffect(() => { load() }, [load])
  const toggle = (id: string) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : s.length >= 100 ? s : [...s, id])
  const add = async () => {
    setBusy(true)
    try { onDone(await api.post<ImportResult>(`${V1}/images/import`, { source: 'photos', ids: sel })) } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }
  return (
    <Modal title="Add from Pocket Photos" onClose={onClose} size="xl" className="picker"
      footer={!notConnected && <><span className="muted small grow">{sel.length ? `${sel.length} chosen` : 'Choose one or more pictures'}</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!sel.length || busy} onClick={add}>{busy ? <><Spinner />Adding…</> : `Add ${sel.length || ''} to the lab`}</button></>}>
      {notConnected ? <NotConnected app="Pocket Photos" error={notConnected} onClose={onClose} /> : <>
        <div className="picker-bar">
          <div className="search-box grow"><Icon name="search" size={15} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Describe a picture: “sunset at the sea”, “dog in snow”…" autoFocus /></div>
          <button type="button" className={`btn ${favs ? 'active-toggle' : ''}`} aria-pressed={favs} onClick={() => setFavs(f => !f)}><Icon name="star" size={15} />Favourites</button>
        </div>
        {error && <div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div>}
        <div className="pick-grid">
          {items.map(it => (
            <button type="button" key={it.id} className={`pick-tile ${sel.includes(it.id) ? 'sel' : ''}`} onClick={() => toggle(it.id)} title={`${it.name}${it.taken_at ? ' · ' + fmtDate(it.taken_at.slice(0, 10)) : ''}`}>
              <img src={`${V1}/sources/photos/${it.id}/thumb`} alt={it.name} loading="lazy" />
              <Check on={sel.includes(it.id)} />
            </button>
          ))}
        </div>
        {loading && <Loading />}
        {!loading && !items.length && !error && <p className="muted center pad">{dq ? 'Nothing matches that description.' : 'No pictures in your library yet.'}</p>}
        {!loading && next && <div className="center pad"><button type="button" className="btn" onClick={() => load(next)}>Show more</button></div>}
      </>}
    </Modal>
  )
}

export function FilesPicker({ onClose, onDone }: { onClose: () => void; onDone: (r: ImportResult) => void }) {
  const { toast } = useToast()
  const [spaces, setSpaces] = useState<Space[] | null>(null)
  const [space, setSpace] = useState('home')
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState('')
  const [notConnected, setNotConnected] = useState('')
  const [sel, setSel] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.get<Space[]>(`${V1}/sources/files/spaces`).then(setSpaces).catch(e => { if ((e as { status?: number }).status === 409) setNotConnected(errMsg(e)); else setError(errMsg(e)) })
  }, [])
  useEffect(() => {
    if (notConnected) return
    setEntries(null); setError('')
    api.get<{ entries: FileEntry[] }>(`${V1}/sources/files/list?${new URLSearchParams({ space, path })}`).then(r => setEntries(r.entries)).catch(e => { if ((e as { status?: number }).status === 409) setNotConnected(errMsg(e)); else setError(errMsg(e)) })
  }, [space, path, notConnected])
  const dirs = (entries || []).filter(e => e.is_dir)
  const pics = (entries || []).filter(e => !e.is_dir)
  const crumbs = path.split('/').filter(Boolean)
  const toggle = (p: string) => setSel(s => s.includes(p) ? s.filter(x => x !== p) : s.length >= 100 ? s : [...s, p])
  const add = async () => {
    setBusy(true)
    try { onDone(await api.post<ImportResult>(`${V1}/images/import`, { source: 'files', space, paths: sel })) } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }
  return (
    <Modal title="Add from Pocket Files" onClose={onClose} size="xl" className="picker"
      footer={!notConnected && <><span className="muted small grow">{sel.length ? `${sel.length} chosen` : 'Open a folder and choose pictures'}</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!sel.length || busy} onClick={add}>{busy ? <><Spinner />Adding…</> : `Add ${sel.length || ''} to the lab`}</button></>}>
      {notConnected ? <NotConnected app="Pocket Files" error={notConnected} onClose={onClose} /> : <>
        <div className="picker-bar">
          {spaces && spaces.length > 1 && <div className="picker-space"><Select ariaLabel="Place" value={space} onChange={v => { setSpace(v); setPath('/'); setSel([]) }} options={spaces.map(s => ({ value: s.id, label: s.name }))} /></div>}
          <nav className="crumbs" aria-label="Folder">
            <button type="button" className="link-btn" onClick={() => setPath('/')}><Icon name="folder" size={14} />{spaces?.find(s => s.id === space)?.name || 'My files'}</button>
            {crumbs.map((c, i) => <span key={i} className="row tight"><Icon name="chevron-right" size={13} className="muted" /><button type="button" className="link-btn" onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
          </nav>
        </div>
        {error && <div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div>}
        {!entries && !error && <Loading />}
        {entries && <>
          {dirs.length > 0 && <div className="folder-list">{dirs.map(d => <button type="button" key={d.path} className="folder-row" onClick={() => setPath(d.path)}><Icon name="folder" size={16} /><span className="ellipsis">{d.name}</span></button>)}</div>}
          <div className="pick-grid">
            {pics.map(f => (
              <button type="button" key={f.path} className={`pick-tile ${sel.includes(f.path) ? 'sel' : ''}`} onClick={() => toggle(f.path)} title={f.name}>
                <img src={`${V1}/sources/files/thumb?${new URLSearchParams({ space, path: f.path })}`} alt={f.name} loading="lazy" />
                <span className="pick-name ellipsis">{f.name}</span>
                <Check on={sel.includes(f.path)} />
              </button>
            ))}
          </div>
          {!dirs.length && !pics.length && <p className="muted center pad">No pictures or folders here.</p>}
        </>}
      </>}
    </Modal>
  )
}

/** Choose pictures already in the lab (the collage). */
export function LabPicker({ title, max, onClose, onDone, initial = [] }: { title: string; max: number; onClose: () => void; onDone: (ims: Image[]) => void; initial?: number[] }) {
  const [q, setQ] = useState('')
  const dq = useDebounce(q, 250)
  const [items, setItems] = useState<Image[] | null>(null)
  const [sel, setSel] = useState<Image[]>([])
  const [initDone, setInitDone] = useState(false)
  useEffect(() => { api.get<{ items: Image[] }>(`${V1}/images?${new URLSearchParams({ q: dq, limit: '300' })}`).then(r => setItems(r.items)).catch(() => setItems([])) }, [dq])
  useEffect(() => { if (!initDone && items) { setSel(initial.map(id => items.find(i => i.id === id)).filter(Boolean) as Image[]); setInitDone(true) } }, [items, initDone, initial])
  const toggle = (im: Image) => setSel(s => s.some(x => x.id === im.id) ? s.filter(x => x.id !== im.id) : s.length >= max ? s : [...s, im])
  return (
    <Modal title={title} onClose={onClose} size="xl" className="picker"
      footer={<><span className="muted small grow">{sel.length} of up to {max} chosen{sel.length ? ' — in the order you picked them' : ''}</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!sel.length} onClick={() => onDone(sel)}>Use {sel.length || ''}</button></>}>
      <div className="picker-bar"><div className="search-box grow"><Icon name="search" size={15} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a picture by name" autoFocus /></div></div>
      {!items ? <Loading /> : <div className="pick-grid">
        {items.map(im => {
          const n = sel.findIndex(x => x.id === im.id)
          return (
            <button type="button" key={im.id} className={`pick-tile ${n >= 0 ? 'sel' : ''}`} onClick={() => toggle(im)} title={im.title}>
              <img src={thumbURL(im)} alt={im.title} loading="lazy" />
              <span className={`pick-check ${n >= 0 ? 'on' : ''}`}>{n >= 0 && n + 1}</span>
            </button>
          )
        })}
      </div>}
      {items && !items.length && <p className="muted center pad">No pictures in the lab yet.</p>}
    </Modal>
  )
}
