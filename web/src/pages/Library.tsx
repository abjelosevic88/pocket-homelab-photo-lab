// Your pictures: everything in the lab, newest work first.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import { useApp } from '../lib/app-context'
import type { Image } from '../lib/types'
import { originalURL, sourceName, thumbURL } from '../lib/images'
import { ago, fmtBytes } from '../lib/format'
import { Icon } from '../components/icons'
import { Select } from '../components/Select'
import { announceChange, openAdd, useOnChange, useSources } from '../components/Layout'
import { BatchDialog } from '../components/BatchDialog'
import { Confirm, Loading, MenuButton, type MenuItem, useDebounce, useIsMobile, useToast, errMsg } from '../components/ui'

const SHOW: { value: string; label: string }[] = [
  { value: '', label: 'All pictures' }, { value: 'edited', label: 'Edited' }, { value: 'unedited', label: 'Not edited yet' }, { value: 'favorites', label: 'Favourites' },
  { value: 'photos', label: 'From Pocket Photos' }, { value: 'files', label: 'From Pocket Files' }, { value: 'upload', label: 'Uploaded' }, { value: 'collage', label: 'Collages' }, { value: 'copy', label: 'Copies' },
]
const SORT = [{ value: 'recent', label: 'Last worked on' }, { value: 'added', label: 'Last added' }, { value: 'taken', label: 'Date taken' }, { value: 'title', label: 'Name' }, { value: 'size', label: 'Largest first' }]
const PAGE = 120

export default function Library() {
  const { settings } = useApp()
  const { toast } = useToast()
  const navigate = useNavigate()
  const mobile = useIsMobile()
  const sources = useSources()
  const [sp, setSp] = useSearchParams()
  const show = sp.get('show') || ''
  const [q, setQ] = useState('')
  const dq = useDebounce(q, 250)
  const [sort, setSort] = useState(settings?.sort || 'recent')
  const [items, setItems] = useState<Image[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [sel, setSel] = useState<number[]>([])
  const [batch, setBatch] = useState(false)
  const [del, setDel] = useState<Image[] | null>(null)

  const load = useCallback(async (more = false, keep = 0) => {
    try {
      const p = new URLSearchParams({ q: dq, show, sort, limit: String(Math.max(PAGE, keep)), offset: more ? String(items?.length || 0) : '0' })
      const r = await api.get<{ items: Image[]; total: number }>(`${V1}/images?${p}`)
      setItems(old => more && old ? [...old, ...r.items.filter(i => !old.some(o => o.id === i.id))] : r.items)
      setTotal(r.total); setError('')
    } catch (e) { setError(errMsg(e)) }
  }, [dq, show, sort]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])
  useOnChange(() => load(false, items?.length || 0))
  useEffect(() => { setSel([]) }, [show, dq])

  const selected = useMemo(() => (items || []).filter(i => sel.includes(i.id)), [items, sel])
  const toggleSel = (id: number) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  const setFav = async (im: Image, v: boolean) => {
    setItems(list => list?.map(x => x.id === im.id ? { ...x, favorite: v } : x) || null)
    try { await api.put(`${V1}/images/${im.id}`, { favorite: v }); announceChange() } catch (e) { toast(errMsg(e), 'err') }
  }
  const copy = async (im: Image, fresh: boolean) => {
    try { const r = await api.post<{ image: Image }>(`${V1}/images/${im.id}/copy`, { fresh }); announceChange(); navigate(`/edit/${r.image.id}`) } catch (e) { toast(errMsg(e), 'err') }
  }
  const remove = async (list: Image[]) => {
    let n = 0
    for (const im of list) { try { await api.del(`${V1}/images/${im.id}`); n++ } catch (e) { toast(errMsg(e), 'err') } }
    setSel([]); setSelecting(false)
    toast(`${n} ${n === 1 ? 'picture' : 'pictures'} removed from the lab`)
    announceChange()
  }
  const menu = (im: Image): MenuItem[] => [
    { label: 'Edit', icon: 'sliders', onSelect: () => navigate(`/edit/${im.id}`) },
    { label: im.favorite ? 'Not a favourite' : 'Favourite', icon: 'star', onSelect: () => setFav(im, !im.favorite) },
    { label: 'Make a copy to try something else', icon: 'copy', onSelect: () => copy(im, false) },
    { label: 'Start again from the original (as a copy)', icon: 'refresh', onSelect: () => copy(im, true) },
    { label: 'Download the original', icon: 'download', onSelect: () => { window.location.href = `${originalURL(im)}&download=1` } },
    'sep',
    { label: 'Remove from the lab', icon: 'trash', danger: true, onSelect: () => setDel([im]) },
  ]
  const title = SHOW.find(s => s.value === show)?.label || 'All pictures'
  const empty = items && items.length === 0
  return (
    <div className="stack loose">
      <div className="lib-head">
        <div className="grow">
          <h2 className="page-title">{show ? title : 'Your pictures'}</h2>
          <p className="muted small">{items ? `${total.toLocaleString()} ${total === 1 ? 'picture' : 'pictures'}` : ' '}{!show && ' · originals are never changed: every edit can be undone'}</p>
        </div>
        {!mobile && <div className="row wrap">
          <button type="button" className="btn primary" onClick={() => openAdd('upload')}><Icon name="upload" size={15} />Upload</button>
          <button type="button" className="btn" onClick={() => openAdd('photos')} disabled={!!sources && !sources.photos.ready} title={sources && !sources.photos.ready ? `Pocket Photos is not connected: ${sources.photos.detail}` : 'Pick pictures from your Pocket Photos library'}><Icon name="images" size={15} />From Photos</button>
          <button type="button" className="btn" onClick={() => openAdd('files')} disabled={!!sources && !sources.files.ready} title={sources && !sources.files.ready ? `Pocket Files is not connected: ${sources.files.detail}` : 'Pick pictures from Pocket Files'}><Icon name="folder" size={15} />From Files</button>
        </div>}
      </div>

      <div className="toolbar lib-tools">
        <div className="search-box"><Icon name="search" size={15} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Find by name or note" aria-label="Find a picture" /></div>
        <Select ariaLabel="Show" value={show} onChange={v => { const n = new URLSearchParams(sp); if (v) n.set('show', v); else n.delete('show'); setSp(n, { replace: true }) }} options={SHOW} />
        <Select ariaLabel="Sort" value={sort} onChange={setSort} options={SORT} />
        <span className="spacer" />
        {!!items?.length && <button type="button" className={`btn ${selecting ? 'active-toggle' : ''}`} aria-pressed={selecting} onClick={() => { setSelecting(s => !s); setSel([]) }}><Icon name="select-all" size={15} />{selecting ? 'Done' : 'Select'}</button>}
      </div>

      {selecting && (
        <div className="sel-bar">
          <span className="grow"><b>{sel.length}</b> selected</span>
          <button type="button" className="btn sm ghost" onClick={() => setSel(sel.length === (items?.length || 0) ? [] : (items || []).map(i => i.id))}>{sel.length === (items?.length || 0) ? 'None' : 'All'}</button>
          <button type="button" className="btn sm primary" disabled={!sel.length} onClick={() => setBatch(true)}><Icon name="wand" size={14} />Edit together…</button>
          <button type="button" className="btn sm" disabled={sel.length < 2 || sel.length > 9} title="2 to 9 pictures" onClick={() => navigate(`/collage?ids=${sel.slice(0, 9).join(',')}`)}><Icon name="collage" size={14} />Collage</button>
          <button type="button" className="btn sm danger-text" disabled={!sel.length} onClick={() => setDel(selected)}><Icon name="trash" size={14} />Remove</button>
        </div>
      )}

      {error && <div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div>}
      {!items && !error && <Loading />}
      {empty && !dq && !show && (
        <div className="lib-empty">
          <div className="lib-empty-art"><Icon name="image" size={34} /></div>
          <h3>Bring a picture into the lab</h3>
          <p className="muted">Upload from this device, drop pictures anywhere on this page, paste a screenshot, or pick from Pocket Photos and Pocket Files. The original stays as it is.</p>
          <div className="row wrap center">
            <button type="button" className="btn primary" onClick={() => openAdd('upload')}><Icon name="upload" size={15} />Upload pictures</button>
            <button type="button" className="btn" onClick={() => openAdd('photos')} disabled={!!sources && !sources.photos.ready}><Icon name="images" size={15} />From Pocket Photos</button>
            <button type="button" className="btn" onClick={() => openAdd('files')} disabled={!!sources && !sources.files.ready}><Icon name="folder" size={15} />From Pocket Files</button>
          </div>
          {sources && (!sources.photos.ready || !sources.files.ready) && <p className="muted small">Pocket Photos and Files need a connection: Settings → Connected apps.</p>}
        </div>
      )}
      {empty && (dq || show) && <p className="muted center pad">Nothing here{dq ? ` matches “${dq}”` : ''}.</p>}

      {!!items?.length && (
        <div className="lib-grid">
          {items.map(im => {
            const on = sel.includes(im.id)
            return (
              <div key={im.id} className={`lib-card ${on ? 'sel' : ''}`}>
                <button type="button" className="lib-thumb" onClick={() => selecting ? toggleSel(im.id) : navigate(`/edit/${im.id}`)} aria-label={selecting ? `Select ${im.title}` : `Edit ${im.title}`}>
                  <img src={thumbURL(im)} alt="" loading="lazy" onError={e => { const t = e.currentTarget; if (!t.dataset.fallback) { t.dataset.fallback = '1'; t.src = originalURL(im) } }} />
                  {selecting && <span className={`pick-check ${on ? 'on' : ''}`}>{on && <Icon name="check" size={14} strokeWidth={2.6} />}</span>}
                  {im.edited && <span className="lib-badge" title="Edited"><Icon name="sliders" size={11} />Edited</span>}
                </button>
                <div className="lib-meta">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="lib-title ellipsis" title={im.title}>{im.title}</div>
                    <div className="lib-sub muted ellipsis">{im.width && im.height ? `${im.width}×${im.height}` : im.mime.replace('image/', '').toUpperCase()} · {sourceName(im.source)} · {ago(im.updated_at)}</div>
                  </div>
                  <button type="button" className={`btn ghost icon-only sm fav ${im.favorite ? 'on' : ''}`} aria-label={im.favorite ? 'Not a favourite' : 'Favourite'} aria-pressed={im.favorite} onClick={() => setFav(im, !im.favorite)}><Icon name="star" size={15} /></button>
                  <MenuButton label="More" className="btn ghost icon-only sm" align="right" width={280} items={() => menu(im)}><Icon name="more" size={15} /></MenuButton>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {items && items.length < total && <div className="center"><button type="button" className="btn" onClick={() => load(true)}>Show more ({(total - items.length).toLocaleString()} left)</button></div>}
      {items && items.length > 0 && <p className="muted small center">{fmtBytes(items.reduce((s, i) => s + i.bytes, 0))} of originals shown</p>}

      {batch && <BatchDialog images={selected} onClose={() => setBatch(false)} onDone={() => { setBatch(false); setSelecting(false); setSel([]); announceChange() }} />}
      {del && <Confirm title={del.length === 1 ? `Remove “${del[0].title}”?` : `Remove ${del.length} pictures?`} confirmLabel="Remove"
        message={<>The {del.length === 1 ? 'picture leaves' : 'pictures leave'} the lab with {del.length === 1 ? 'its' : 'their'} edits and saved versions. Anything in Pocket Photos or Pocket Files stays where it is.</>}
        onCancel={() => setDel(null)} onConfirm={() => { const d = del; setDel(null); remove(d) }} />}
    </div>
  )
}
