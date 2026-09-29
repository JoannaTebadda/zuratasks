CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    completed  INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    priority   TEXT    NOT NULL DEFAULT 'medium'
               CHECK (priority IN ('high', 'medium', 'low')),
    due_date   TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_active
    ON tasks (completed, id DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_due
    ON tasks (due_date);
