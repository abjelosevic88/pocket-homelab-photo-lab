// The app shell: sidebar, top bar, search palette, shortcuts, and adding
// pictures from anywhere (upload, drop, paste, Pocket Photos, Pocket Files).
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import { useApp } from '../lib/app-context'
import type { HomeData, Image, ImportResult, Sources } from '../lib/types'
import { importSummary, uploadMany } from '../lib/images'
import { Icon } from './icons'
import { Sidebar } from './Sidebar'
import { CommandPalette, type PaletteCommand } from './CommandPalette'
import { ShortcutsSheet } from './ShortcutsSheet'
import { PhotosPicker, FilesPicker } from './Pickers'
import { Avatar, type Anchor, type MenuItem, Menu, MenuButton, modalOpen, rectOf, useIsMobile, useMediaQuery, useToast } from './ui'
import { AskButton } from './AskButton'

const SIDEBAR_KEY = 'plab-sidebar'

/** Something was added or changed from the shell (or a page): the counts and the pages reload. */
export const announceChange = () => window.dispatchEvent(new CustomEvent('plab:changed'))
export function useOnChange(cb: () => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    const h = () => ref.current()
    window.addEventListener('plab:changed', h)
    return () => window.removeEventListener('plab:changed', h)
  }, [])
}

/** The page's own name for the top bar breadcrumb. */
const CrumbCtx = createContext<(t: string) => void>(() => {})
export function useCrumb(title: string | undefined) {
  const set = useContext(CrumbCtx)
  useEffect(() => { set(title || ''); return () => set('') }, [title, set])
}

export type AddKind = 'upload' | 'photos' | 'files' | 'collage'

/** Open "add pictures" from anywhere (a page's button). */
export const openAdd = (k: AddKind) => window.dispatchEvent(new CustomEvent('plab:add', { detail: { kind: k } }))

/** How the person reaches Pocket Photos and Files (for greying out). */
const SourcesCtx = createContext<Sources | null>(null)
export const useSources = () => useContext(SourcesCtx)

/** The add menu: the sidebar's button and the phone's + button. */
export function addItems(onAdd: (k: AddKind) => void, src: Sources | null): MenuItem[] {
  const off = (k: 'photos' | 'files') => !!src && !src[k].ready
  return [
    { label: 'Upload from this device…', icon: 'upload', hint: 'U', onSelect: () => onAdd('upload') },
    { label: 'From Pocket Photos…', icon: 'images', hint: off('photos') ? 'not connected' : 'P', disabled: off('photos'), onSelect: () => onAdd('photos') },
    { label: 'From Pocket Files…', icon: 'folder', hint: off('files') ? 'not connected' : 'F', disabled: off('files'), onSelect: () => onAdd('files') },
    'sep',
    { label: 'Make a collage', icon: 'collage', hint: 'C', onSelect: () => onAdd('collage') },
  ]
}

export default function Layout() {
  const navigate = useNavigate()
  const loc = useLocation()
  const { toast } = useToast()
  const mobile = useIsMobile()
  const narrow = useMediaQuery('(max-width: 1099px)')
  const drawer = mobile || narrow
  const [sidebarOpen, setSidebarOpen] = useState(() => !drawer && localStorage.getItem(SIDEBAR_KEY) !== '0')
  useEffect(() => { setSidebarOpen(!drawer && localStorage.getItem(SIDEBAR_KEY) !== '0') }, [drawer])
  const drawerOpenedAt = useRef(0)
  const toggleSidebar = () => setSidebarOpen(o => { drawerOpenedAt.current = performance.now(); const n = !o; if (!drawer) localStorage.setItem(SIDEBAR_KEY, n ? '1' : '0'); return n })
  const closeDrawer = () => { if (drawer) setSidebarOpen(false) }
  useEffect(() => { document.querySelector('.content')?.scrollTo({ top: 0 }) }, [loc.pathname])

  const [crumb, setCrumbRaw] = useState('')
  const setCrumb = useCallback((t: string) => setCrumbRaw(t), [])

  const [home, setHome] = useState<HomeData | null>(null)
  const [sources, setSources] = useState<Sources | null>(null)
  const load = useCallback(() => { api.get<HomeData>(`${V1}/home`).then(setHome).catch(() => {}) }, [])
  const loadSources = useCallback(() => { api.get<Sources>(`${V1}/sources`).then(setSources).catch(() => {}) }, [])
  useEffect(() => { load() }, [loc.pathname, load])
  useEffect(() => { loadSources() }, [loadSources])
  useOnChange(() => { load(); loadSources() })

  const [palette, setPalette] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [picker, setPicker] = useState<'photos' | 'files' | null>(null)
  const [fabMenu, setFabMenu] = useState<Anchor | null>(null)
  const [busy, setBusy] = useState('')
  const [dropping, setDropping] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  /** After pictures arrived: one opens in the editor, several stay in the library. */
  const arrived = useCallback((r: ImportResult) => {
    announceChange()
    const all = [...r.items, ...r.already]
    if (all.length === 1 && r.skipped.length === 0) { navigate(`/edit/${all[0].id}`); if (r.already.length) toast('Already in the lab: opened it'); return }
    toast(importSummary(r), r.items.length || r.already.length ? 'ok' : 'err')
    if (loc.pathname !== '/') navigate('/')
  }, [navigate, toast, loc.pathname])

  const uploadFiles = useCallback(async (files: File[]) => {
    const pics = files.filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|bmp|tiff?|heic|heif)$/i.test(f.name))
    if (!pics.length) { toast('Those are not pictures', 'err'); return }
    setBusy(`Uploading 0 of ${pics.length}…`)
    try { arrived(await uploadMany(pics, (d, t) => setBusy(`Uploading ${d} of ${t}…`))) } finally { setBusy('') }
  }, [arrived, toast])

  const add = (k: AddKind) => {
    closeDrawer()
    switch (k) {
      case 'upload': fileInput.current?.click(); break
      case 'photos': case 'files': setPicker(k); break
      case 'collage': navigate('/collage'); break
    }
  }
  const addRef = useRef(add)
  addRef.current = add

  useEffect(() => {
    const open = () => setShortcuts(true)
    const make = (e: Event) => { const d = (e as CustomEvent<{ kind: AddKind }>).detail; addRef.current(d.kind) }
    window.addEventListener('plab:shortcuts', open)
    window.addEventListener('plab:add', make)
    return () => { window.removeEventListener('plab:shortcuts', open); window.removeEventListener('plab:add', make) }
  }, [])
  // paste a picture (a screenshot) anywhere in the library
  useEffect(() => {
    const h = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement
      if (t?.closest?.('input, textarea, [contenteditable="true"]')) return
      const files = Array.from(e.clipboardData?.files || []).filter(f => f.type.startsWith('image/'))
      if (!files.length) return
      e.preventDefault()
      uploadFiles(files.map((f, i) => f.name && f.name !== 'image.png' ? f : new File([f], `Pasted ${new Date().toLocaleString()}${files.length > 1 ? ` ${i + 1}` : ''}.${f.type.split('/')[1] || 'png'}`, { type: f.type })))
    }
    window.addEventListener('paste', h)
    return () => window.removeEventListener('paste', h)
  }, [uploadFiles])
  // drop pictures anywhere
  useEffect(() => {
    let depth = 0
    const has = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files')
    const enter = (e: DragEvent) => { if (!has(e)) return; depth++; setDropping(true) }
    const leave = (e: DragEvent) => { if (!has(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDropping(false) }
    const over = (e: DragEvent) => { if (has(e)) e.preventDefault() }
    const drop = (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); depth = 0; setDropping(false); uploadFiles(Array.from(e.dataTransfer?.files || [])) }
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave); window.addEventListener('dragover', over); window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop) }
  }, [uploadFiles])
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); return }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (t.closest('input, textarea, select, [contenteditable="true"]') || modalOpen() || document.querySelector('.menu, .popover, .sel-pop')) return
      const go = (to: string) => { e.preventDefault(); navigate(to) }
      const mk = (k: AddKind) => { e.preventDefault(); addRef.current(k) }
      switch (e.key) {
        case '/': e.preventDefault(); setPalette(true); break
        case '?': e.preventDefault(); setShortcuts(true); break
        case 'u': mk('upload'); break
        case 'p': if (!sources || sources.photos.ready) mk('photos'); break
        case 'f': if (!sources || sources.files.ready) mk('files'); break
        case 'h': go('/'); break
        case 'l': go('/looks'); break
        case 'c': go('/collage'); break
        case 'y': go('/history'); break
        case ',': go('/settings'); break
        case '[': e.preventDefault(); toggleSidebar(); break
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  const images: Image[] = home?.recent || []
  const commands: PaletteCommand[] = [
    { id: 'upload', label: 'Upload pictures', icon: 'upload', hint: 'U', keywords: 'add new import device phone', run: () => add('upload') },
    { id: 'photos', label: 'Add from Pocket Photos', icon: 'images', hint: 'P', keywords: 'immich library import', run: () => add('photos') },
    { id: 'files', label: 'Add from Pocket Files', icon: 'folder', hint: 'F', keywords: 'folder import', run: () => add('files') },
    { id: 'home', label: 'Your pictures', icon: 'image', hint: 'H', keywords: 'library home all', run: () => navigate('/') },
    { id: 'edited', label: 'Edited pictures', icon: 'sliders', run: () => navigate('/?show=edited') },
    { id: 'favs', label: 'Favourites', icon: 'star', run: () => navigate('/?show=favorites') },
    { id: 'looks', label: 'Looks and filters', icon: 'palette', hint: 'L', keywords: 'presets filters styles', run: () => navigate('/looks') },
    { id: 'collage', label: 'Make a collage', icon: 'collage', hint: 'C', keywords: 'grid layout combine', run: () => navigate('/collage') },
    { id: 'history', label: 'History: what you saved', icon: 'history', hint: 'Y', keywords: 'exports saved downloads', run: () => navigate('/history') },
    { id: 'settings', label: 'Settings', icon: 'settings', hint: ',', run: () => navigate('/settings') },
    { id: 'saving', label: 'Settings: saving pictures', icon: 'download', keywords: 'export format quality jpeg png webp size', run: () => navigate('/settings/saving') },
    { id: 'apps', label: 'Settings: connected apps', icon: 'layers', keywords: 'photos files core integrations', run: () => navigate('/settings/apps') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', run: () => setShortcuts(true) },
  ]

  return (
    <CrumbCtx.Provider value={setCrumb}>
      <SourcesCtx.Provider value={sources}>
        <div className={`app ${sidebarOpen ? 'with-sidebar' : 'no-sidebar'} ${mobile ? 'is-mobile' : ''} ${drawer ? 'drawer-mode' : ''}`}>
          {drawer && sidebarOpen && <div className="drawer-backdrop" onClick={e => { if (e.timeStamp - drawerOpenedAt.current > 400) setSidebarOpen(false) }} />}
          <div className={`sidebar-wrap ${sidebarOpen ? 'open' : ''}`}>
            <Sidebar onAdd={add} onNavigate={closeDrawer} home={home} sources={sources} />
          </div>
          <div className="main">
            <TopBar onMenu={toggleSidebar} onPalette={() => setPalette(true)} mobile={mobile} compact={narrow} sidebarOpen={sidebarOpen} crumb={crumb} busy={busy} />
            <main className="content"><div className="content-inner"><Outlet /></div></main>
          </div>
          {mobile && <button type="button" className="fab" aria-label="Add pictures" title="Add pictures" aria-haspopup="menu" aria-expanded={!!fabMenu} onClick={e => setFabMenu(fabMenu ? null : rectOf(e.currentTarget))}><Icon name="plus" size={24} strokeWidth={2.2} /></button>}
          {fabMenu && <Menu anchor={fabMenu} align="right" items={addItems(add, sources)} onClose={() => setFabMenu(null)} width={250} />}
          {palette && <CommandPalette onClose={() => setPalette(false)} commands={commands} images={images} />}
          {shortcuts && <ShortcutsSheet onClose={() => setShortcuts(false)} />}
          {picker === 'photos' && <PhotosPicker onClose={() => setPicker(null)} onDone={r => { setPicker(null); arrived(r) }} />}
          {picker === 'files' && <FilesPicker onClose={() => setPicker(null)} onDone={r => { setPicker(null); arrived(r) }} />}
          <input ref={fileInput} type="file" accept="image/*,.heic,.heif,.avif,.tif,.tiff" multiple hidden onChange={e => { const fs = Array.from(e.target.files || []); e.target.value = ''; if (fs.length) uploadFiles(fs) }} />
          {dropping && <div className="drop-veil"><div><Icon name="upload" size={30} /><b>Drop to add to the lab</b><span>JPEG, PNG, WebP, GIF, AVIF, BMP or TIFF</span></div></div>}
        </div>
      </SourcesCtx.Provider>
    </CrumbCtx.Provider>
  )
}

const SECTION: Record<string, [string, string]> = { '': ['Pictures', '/'], looks: ['Looks', '/looks'], collage: ['Collage', '/collage'], history: ['History', '/history'] }

function TopBar({ onMenu, onPalette, mobile, compact, sidebarOpen, crumb, busy }: { onMenu: () => void; onPalette: () => void; mobile: boolean; compact: boolean; sidebarOpen: boolean; crumb: string; busy: string }) {
  const { user, themeMode, setThemeMode, status, setUser } = useApp()
  const navigate = useNavigate()
  const loc = useLocation()
  const [section, sectionTo] = SECTION[loc.pathname.split('/')[1] || ''] || ['', '/']
  const signOut = async () => { await api.post(`${V1}/auth/logout`).catch(() => {}); setUser(null); navigate('/login') }
  const avatarMenu = (): MenuItem[] => [
    { heading: user?.name || user?.email || '' },
    { label: 'Profile', icon: 'user', onSelect: () => navigate('/settings/profile') },
    { label: 'Settings', icon: 'settings', onSelect: () => navigate('/settings'), hint: ',' },
    { label: 'Keyboard shortcuts', icon: 'keyboard', onSelect: () => window.dispatchEvent(new CustomEvent('plab:shortcuts')), hint: '?' },
    'sep',
    { heading: 'Appearance' },
    { label: 'System', checked: themeMode === 'system', onSelect: () => setThemeMode('system') },
    { label: 'Light', checked: themeMode === 'light', onSelect: () => setThemeMode('light') },
    { label: 'Dark', checked: themeMode === 'dark', onSelect: () => setThemeMode('dark') },
    ...(status?.auth_mode === 'local' ? ['sep' as const, { label: 'Sign out', icon: 'log-out', onSelect: signOut }] : []),
  ]
  return (
    <header className="topbar">
      <button type="button" className="btn ghost icon-only" onClick={onMenu} aria-label={sidebarOpen ? 'Hide the sidebar' : 'Show the sidebar'} title="Menu ([)"><Icon name={mobile || compact ? 'menu' : 'sidebar'} size={18} /></button>
      <h1 className="range-title">
        {crumb ? <><button type="button" className="crumb" onClick={() => navigate(sectionTo)}>{section}</button><Icon name="chevron-right" size={16} className="crumb-sep" /><span className="ellipsis">{crumb}</span></> : section}
      </h1>
      <span className="spacer" />
      <span className="topbar-busy small muted" aria-live="polite">{busy && <><span className="spinner" />{busy}</>}</span>
      <button type="button" className="btn ghost icon-only" onClick={onPalette} aria-label="Search" title="Search (⌘K or /)"><Icon name="search" size={18} /></button>
      <AskButton />
      <MenuButton label="Account" className="avatar-btn" align="right" width={220} items={avatarMenu}>
        <Avatar name={user?.name} email={user?.email} size={30} />
      </MenuButton>
    </header>
  )
}
