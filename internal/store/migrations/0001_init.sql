CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'member',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL DEFAULT '',
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Box-wide settings (title, setup flag); everything else is personal.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, key)
);

CREATE TABLE cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL
);


-- A picture in the lab: the original kept as it came (a file in IMAGES_DIR),
-- the edit as a recipe (JSON, applied in the browser, never baked into the
-- original), a rendered preview of the current look and a small thumbnail.
CREATE TABLE images (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL DEFAULT '',
  file           TEXT NOT NULL,                     -- the original, relative to IMAGES_DIR
  mime           TEXT NOT NULL DEFAULT '',
  width          INTEGER NOT NULL DEFAULT 0,        -- as seen (camera rotation applied)
  height         INTEGER NOT NULL DEFAULT 0,
  bytes          INTEGER NOT NULL DEFAULT 0,
  sha256         TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT 'upload',    -- upload | photos | files | copy | collage | <pocket app slug>
  source_ref     TEXT NOT NULL DEFAULT '',          -- the Pocket Photos asset id, the Pocket Files path …
  source_name    TEXT NOT NULL DEFAULT '',          -- the file name it came with
  recipe         TEXT NOT NULL DEFAULT '{}',        -- the edit (web/src/lib/recipe.ts)
  edited         INTEGER NOT NULL DEFAULT 0,        -- the recipe changes something
  preview        TEXT NOT NULL DEFAULT '',          -- the current look, at most 2048 px (relative to IMAGES_DIR)
  thumb          BLOB,                              -- the current look, 480 px JPEG
  favorite       INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  taken_at       TEXT NOT NULL DEFAULT '',
  exports        INTEGER NOT NULL DEFAULT 0,
  last_export_at TEXT NOT NULL DEFAULT '',
  edited_at      TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX images_user_updated ON images(user_id, updated_at);
CREATE INDEX images_user_source ON images(user_id, source, source_ref);
CREATE INDEX images_user_sha ON images(user_id, sha256);

-- A saved state of an edit to come back to ("Before the crop", "Warm").
CREATE TABLE versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_id   INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  recipe     TEXT NOT NULL DEFAULT '{}',
  thumb      BLOB,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX versions_user_image ON versions(user_id, image_id);

-- A look of your own: light, colour and effects to put on any picture.
CREATE TABLE presets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  recipe     TEXT NOT NULL DEFAULT '{}',
  thumb      BLOB,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX presets_user_name ON presets(user_id, name);

-- What left the lab, and where to: a download, Pocket Photos, Pocket Files.
CREATE TABLE exports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_id    INTEGER REFERENCES images(id) ON DELETE SET NULL,
  title       TEXT NOT NULL DEFAULT '',
  format      TEXT NOT NULL DEFAULT '',             -- jpeg | png | webp | avif
  width       INTEGER NOT NULL DEFAULT 0,
  height      INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  destination TEXT NOT NULL DEFAULT 'download',     -- download | photos | files
  target      TEXT NOT NULL DEFAULT '',             -- the new Pocket Photos asset id, the Pocket Files path
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX exports_user_created ON exports(user_id, created_at);
