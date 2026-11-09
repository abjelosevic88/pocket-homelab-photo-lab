# Backup

Two things to keep: the SQLite file `DATA_DIR/pocket-photolab.db` (accounts, edits, looks, versions, the save history; WAL mode) and the pictures in `IMAGES_DIR` (default `DATA_DIR/images`: every original and the rendered current looks). Back up the whole data volume, or:

- `pocket-photolab backup` writes a consistent copy of the database to `DATA_DIR/backups/pocket-photolab-<time>.db` (`VACUUM INTO`); Settings → Backup & data → Download database does the same (admin). Back up that copy, not the live file, together with `images/`.
- `DATA_DIR/core.token*` is the Pocket Core registration.

Restore: stop the app, put back `pocket-photolab.db` (remove `-wal`/`-shm` files) and `images/`, start.

Every person can also download everything of theirs as a ZIP (originals, current looks, `export.json`) from Settings → Backup & data, and export/import their edits and looks as JSON.
