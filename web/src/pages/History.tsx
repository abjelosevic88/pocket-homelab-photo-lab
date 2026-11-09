// History: every picture you saved out of the lab, and where it went.
import { Link } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import type { Export } from '../lib/types'
import { fmtBytes, fmtDate, fmtISOTime } from '../lib/format'
import { Icon } from '../components/icons'
import { useOnChange } from '../components/Layout'
import { Empty, Loading, useAsync } from '../components/ui'

const DEST: Record<string, [string, string]> = { download: ['download', 'Downloaded'], photos: ['images', 'Pocket Photos'], files: ['folder', 'Pocket Files'] }

export default function History() {
  const { data, error, reload } = useAsync(() => api.get<Export[]>(`${V1}/exports?limit=500`), [])
  useOnChange(reload)
  if (error) return <div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div>
  if (!data) return <Loading />
  const days: [string, Export[]][] = []
  for (const e of data) { const d = e.created_at.slice(0, 10); const last = days[days.length - 1]; if (last && last[0] === d) last[1].push(e); else days.push([d, [e]]) }
  return (
    <div className="stack loose">
      <div className="lib-head"><div className="grow"><h2 className="page-title">History</h2><p className="muted small">What you saved out of the lab. The edits stay in the lab, so you can always make another copy.</p></div></div>
      {!data.length && <Empty title="Nothing saved yet" icon="history">In the editor, “Save a copy” downloads a picture or sends it to Pocket Photos or Pocket Files.</Empty>}
      {days.map(([d, list]) => (
        <section key={d} className="card">
          <div className="day-h">{fmtDate(d)}</div>
          <ul className="list">
            {list.map(e => {
              const [icon, label] = DEST[e.destination] || ['download', e.destination]
              const row = <>
                {e.image_id ? <img className="hist-thumb" src={`${V1}/images/${e.image_id}/thumb`} alt="" loading="lazy" /> : <span className="list-ico"><Icon name="image" size={16} /></span>}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis"><b>{e.title || 'A picture'}</b></div>
                  <div className="muted small ellipsis">{e.format.toUpperCase()} · {e.width}×{e.height}{e.bytes ? ` · ${fmtBytes(e.bytes)}` : ''}{e.target && e.destination === 'files' ? ` · ${e.target}` : ''}</div>
                </div>
                <span className="hist-dest small muted"><Icon name={icon} size={14} />{label}</span>
                <span className="muted small tnum">{fmtISOTime(e.created_at)}</span>
              </>
              return <li key={e.id}>{e.image_id ? <Link to={`/edit/${e.image_id}`} className="list-row">{row}</Link> : <div className="list-row">{row}</div>}</li>
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
