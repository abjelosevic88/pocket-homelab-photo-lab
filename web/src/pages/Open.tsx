// /open?photos=<id>[,<id>…] or /open?files=<space>:<path> — where "Edit in
// Photo Lab" in other Pocket apps lands: bring the picture in, open the editor.
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import type { ImportResult } from '../lib/types'
import { importSummary } from '../lib/images'
import { Icon } from '../components/icons'
import { announceChange } from '../components/Layout'
import { Loading, errMsg } from '../components/ui'

export default function Open() {
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  useEffect(() => {
    const photos = (sp.get('photos') || '').split(',').map(s => s.trim()).filter(Boolean)
    const files = sp.get('files') || ''
    let body: Record<string, unknown> | null = null
    if (photos.length) body = { source: 'photos', ids: photos.slice(0, 100) }
    else if (files.includes(':')) { const i = files.indexOf(':'); body = { source: 'files', space: files.slice(0, i), paths: [files.slice(i + 1)] } }
    if (!body) { setError('Nothing to open: the link names no picture.'); return }
    api.post<ImportResult>(`${V1}/images/import`, body).then(r => {
      announceChange()
      const all = [...r.items, ...r.already]
      if (all.length === 1) navigate(`/edit/${all[0].id}${sp.get('tool') ? `?tool=${sp.get('tool')}` : ''}`, { replace: true })
      else if (all.length > 1) navigate('/', { replace: true })
      else setError(importSummary(r))
    }).catch(e => setError(errMsg(e)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <div className="stack"><div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div><div className="row"><Link className="btn" to="/">Your pictures</Link><Link className="btn" to="/settings/apps">Connected apps</Link></div></div>
  return <Loading label="Bringing the picture into the lab…" />
}
