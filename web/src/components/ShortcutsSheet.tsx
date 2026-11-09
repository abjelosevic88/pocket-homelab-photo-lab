import { Modal } from './ui'

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  { title: 'Go to', keys: [[['h'], 'Your pictures'], [['l'], 'Looks'], [['c'], 'Collage'], [['y'], 'History'], [[','], 'Settings'], [['/'], 'Search & commands'], [['⌘', 'K'], 'Search & commands']] },
  { title: 'Add pictures', keys: [[['u'], 'Upload from this device'], [['p'], 'From Pocket Photos'], [['f'], 'From Pocket Files'], [['⌘', 'V'], 'Paste a picture']] },
  { title: 'In the editor', keys: [[['⌘', 'Z'], 'Undo'], [['⇧', '⌘', 'Z'], 'Redo'], [['\\'], 'Hold to see the original'], [['0'], 'Fit to the window'], [['+', '−'], 'Zoom'], [['c'], 'Crop'], [['a'], 'Adjust'], [['m'], 'Local adjustments'], [['j'], 'Heal'], [['b'], 'Background'], [['t'], 'Text'], [['←', '→'], 'Nudge the selected text or shape'], [['e'], 'Save a copy (export)'], [['del'], 'Remove the selected text or shape'], [['esc'], 'Back to your pictures']] },
  { title: 'Window', keys: [[['['], 'Show or hide the sidebar'], [['esc'], 'Close a dialog or menu']] },
  { title: 'Help', keys: [[['?'], 'This sheet']] },
]

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} size="lg">
      <div className="shortcuts">
        {GROUPS.map(g => (
          <section key={g.title}>
            <h4 className="sc-h">{g.title}</h4>
            {g.keys.map(([keys, label]) => (
              <div key={label + keys.join('')} className="sc-row"><span>{label}</span><span className="sc-keys">{keys.map(k => <kbd key={k}>{k}</kbd>)}</span></div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  )
}
