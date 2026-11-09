-- The camera a picture came from (kept in saved copies when the person wants),
-- and whether the rendered look is behind the edit (an app changed it; the
-- next browser that opens the library renders it again).
ALTER TABLE images ADD COLUMN camera TEXT NOT NULL DEFAULT '';
ALTER TABLE images ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;

-- Fonts of one's own for text on pictures.
CREATE TABLE fonts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  file       TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT '',
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX fonts_user ON fonts(user_id);
