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
