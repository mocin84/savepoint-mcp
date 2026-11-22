CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,          -- sha256 of the project code (code itself is never stored)
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,          -- ms epoch
  last_activity INTEGER NOT NULL,          -- ms epoch, updated on WRITES only
  total_bytes   INTEGER NOT NULL DEFAULT 0,
  file_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_projects_activity ON projects(last_activity);
CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key    TEXT PRIMARY KEY,                 -- ip:minuteWindow
  window INTEGER NOT NULL,
  count  INTEGER NOT NULL
);

-- Phase 2: per-file index with versions (optimistic concurrency)
CREATE TABLE IF NOT EXISTS files (
  project_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ctype      TEXT,                         -- NULL = text file; otherwise the binary content type
  PRIMARY KEY (project_id, path)
);

-- Phase 3: temporary download links (zip is stored in R2 at p/<id>/dl/<token>.zip)
CREATE TABLE IF NOT EXISTS downloads (
  token      TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_downloads_expires ON downloads(expires_at);
CREATE INDEX IF NOT EXISTS idx_downloads_project ON downloads(project_id);

-- Google accounts that have signed in (name, email, first/last sign-in, count).
-- Created lazily by the Worker too, so existing databases need no migration.
CREATE TABLE IF NOT EXISTS users (
  google_sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  sign_ins INTEGER NOT NULL DEFAULT 1
);

-- Short-lived upload links (binary assets) and asset download links.
-- token_hash = sha256(token); the token itself is never stored. Created lazily too.
CREATE TABLE IF NOT EXISTS links (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                -- 'upload' | 'asset'
  project_id TEXT NOT NULL,
  path       TEXT NOT NULL,                -- upload: target folder; asset: file path
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_expires ON links(expires_at);
