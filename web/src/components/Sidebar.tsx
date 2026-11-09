// Left column: add pictures, sections, quick filters, storage — the Pocket Calendar sidebar.
import { useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useApp } from '../lib/app-context'
import type { HomeData, Sources } from '../lib/types'
import { fmtBytes } from '../lib/format'
import { Icon } from './icons'
import { addItems, type AddKind } from './Layout'
import { type Anchor, Menu, rectOf } from './ui'

export function Sidebar({ onAdd, onNavigate, home, sources }: { onAdd: (k: AddKind) => void; onNavigate: () => void; home: HomeData | null; sources: Sources | null }) {
  const { status, settings } = useApp()
  const loc = useLocation()
  const [menu, setMenu] = useState<Anchor | null>(null)
  const title = settings?.title || status?.title || 'Pocket Photo Lab'
  const st = home?.stats
  const show = new URLSearchParams(loc.search).get('show') || ''
  const nav: { to: string; label: string; icon: string; end?: boolean; count?: number }[] = [
    { to: '/', label: 'Pictures', icon: 'image', end: true, count: st?.images },
    { to: '/looks', label: 'Looks', icon: 'palette', count: st?.presets || undefined },
    { to: '/collage', label: 'Collage', icon: 'collage' },
    { to: '/history', label: 'History', icon: 'history', count: st?.exports || undefined },
  ]
  const filters: { show: string; label: string; icon: string; count?: number }[] = [
    { show: 'edited', label: 'Edited', icon: 'sliders', count: st?.edited },
    { show: 'unedited', label: 'Not edited yet', icon: 'circle' },
    { show: 'favorites', label: 'Favourites', icon: 'star', count: st?.favorites },
    { show: 'photos', label: 'From Pocket Photos', icon: 'images' },
    { show: 'files', label: 'From Pocket Files', icon: 'folder' },
    { show: 'upload', label: 'Uploaded', icon: 'upload' },
  ]
  return (
    <aside className="sidebar" aria-label="Photo Lab">
      <div className="sb-brand">
        <img src="/favicon.svg" alt="" className="sb-logo" />
        <span className="sb-title">{title !== 'Pocket Photo Lab' ? title : <>Pocket <b>Photo Lab</b></>}</span>
        {status?.version && <span className="sb-version" title={`Version ${status.version}`}>{/^v?\d+\.\d+/.test(status.version) ? 'v' + status.version.replace(/^v/, '').replace(/[-+].*$/, '') : status.version}</span>}
      </div>
      <button type="button" className="btn primary create-btn" aria-haspopup="menu" aria-expanded={!!menu} onClick={e => setMenu(menu ? null : rectOf(e.currentTarget))}>
        <Icon name="plus" size={15} strokeWidth={2.2} />Add pictures<Icon name="chevron-down" size={15} className="create-caret" />
      </button>
      {menu && <Menu anchor={menu} items={addItems(onAdd, sources)} onClose={() => setMenu(null)} width={258} />}

      <nav className="sb-nav" aria-label="Sections">
        {nav.map(n => (
          <NavLink key={n.to} to={n.to} end={n.end} onClick={onNavigate} className={({ isActive }) => `sb-nav-item ${isActive && !(n.to === '/' && show) ? 'active' : ''}`}>
            <Icon name={n.icon} size={16} />{n.label}
            {!!n.count && <span className="sb-count">{n.count.toLocaleString()}</span>}
          </NavLink>
        ))}
      </nav>

      <section className="sb-sec">
        <h4 className="sb-h"><span className="sb-h-btn">Show</span></h4>
        <nav className="sb-nav" aria-label="Filters">
          {filters.map(f => (
            <Link key={f.show} to={`/?show=${f.show}`} onClick={onNavigate} className={`sb-nav-item sub ${loc.pathname === '/' && show === f.show ? 'active' : ''}`}>
              <Icon name={f.icon} size={15} />{f.label}
              {!!f.count && <span className="sb-count">{f.count.toLocaleString()}</span>}
            </Link>
          ))}
        </nav>
      </section>

      {sources && (!sources.photos.ready || !sources.files.ready) && (
        <section className="sb-sec">
          <p className="sb-src-note small muted">
            {!sources.photos.ready && <>Pocket Photos is not connected. </>}
            {!sources.files.ready && <>Pocket Files is not connected. </>}
            <Link to="/settings/apps" onClick={onNavigate}>Connect</Link>
          </p>
        </section>
      )}

      {st && st.images > 0 && <div className="sb-storage small muted"><Icon name="database" size={13} />{st.images.toLocaleString()} {st.images === 1 ? 'picture' : 'pictures'} · {fmtBytes(st.bytes)}</div>}

      <div className="sb-foot">
        <Link to="/settings" className="sb-foot-link" onClick={onNavigate}><Icon name="settings" size={15} />Settings</Link>
        <button type="button" className="sb-foot-link" onClick={() => { onNavigate(); window.dispatchEvent(new CustomEvent('plab:shortcuts')) }}><Icon name="keyboard" size={15} />Shortcuts</button>
      </div>
    </aside>
  )
}
