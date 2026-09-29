"""ZuraTasks - a to-do list with priority groups, due dates and a calendar.

Backend: Flask + SQLite. Frontend: vanilla JS in static/app.js.
"""

import logging
import os
import platform
import sqlite3
import tempfile
from datetime import date
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent

PRIORITIES = ("high", "medium", "low")
DEFAULT_PRIORITY = "medium"

app = Flask(__name__)
log = logging.getLogger("zuratasks")


def _database_path():
    """Return the SQLite file to use.

    * ``ZURATASKS_DB`` wins when set, so you can point the app at any file.
    * On Vercel the deployment directory is read-only, so the file goes to
      ``/tmp``, the only writable place inside a Function. Read the deployment
      notes in the README: that storage is per-instance and does not survive a
      cold start, which is why Vercel's advice is a hosted database instead.
    * Everywhere else it is ``tasks.db`` next to ``app.py``, exactly as before.
    """
    override = os.environ.get("ZURATASKS_DB")
    if override:
        return Path(override)
    if os.environ.get("VERCEL"):
        return Path(tempfile.gettempdir()) / "tasks.db"
    return BASE_DIR / "tasks.db"


DATABASE = _database_path()


# --------------------------------------------------------------------------- #
# Database helpers
# --------------------------------------------------------------------------- #
def get_db():
    """Return a connection to the SQLite database, scoped to this request."""
    if "db" not in g:
        # A timeout keeps concurrent requests in one Function from failing with
        # "database is locked" while another one commits.
        g.db = sqlite3.connect(DATABASE, timeout=10)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    """Close the connection at the end of every request."""
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    """Create the tables from schema.sql and patch up older database files."""
    db = sqlite3.connect(DATABASE)
    try:
        # Migrate first: schema.sql indexes columns that older files lack, and
        # CREATE TABLE IF NOT EXISTS would leave such a file untouched.
        _migrate(db)
        db.executescript((BASE_DIR / "schema.sql").read_text(encoding="utf-8"))
        db.commit()
    finally:
        db.close()


def _migrate(db):
    """Add columns introduced after the first release to pre-existing files.

    SQLite's ALTER TABLE cannot add CHECK constraints, so these columns are
    plain columns; the validators below keep the values honest at the API edge.
    """
    tables = {row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    )}
    if "tasks" not in tables:
        return      # a fresh database: schema.sql creates the full table

    existing = {row[1] for row in db.execute("PRAGMA table_info(tasks)")}
    additions = {
        "priority": "ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL "
                    "DEFAULT 'medium'",
        "due_date": "ALTER TABLE tasks ADD COLUMN due_date TEXT",
    }
    for column, statement in additions.items():
        if column not in existing:
            db.execute(statement)


def database_writable():
    """True when the folder holding the database accepts writes.

    This is what tells a broken deployment apart from an empty one: on Vercel
    the deployment directory is read-only and only ``/tmp`` accepts writes.
    """
    if not os.access(DATABASE.parent, os.W_OK):
        return False
    probe = DATABASE.parent / ".zuratasks-write-test"
    try:
        probe.touch(exist_ok=True)
        probe.unlink()
    except OSError:
        return False
    return True


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def validate_title(value):
    """Return (title, error) for a user supplied task title."""
    title = str(value or "").strip()
    if not title:
        return None, "Task title cannot be empty."
    if len(title) > 200:
        return None, "Keep tasks under 200 characters."
    return title, None


def validate_priority(value):
    """Return (priority, error). Missing values fall back to 'medium'."""
    priority = str(value or DEFAULT_PRIORITY).strip().lower()
    if priority not in PRIORITIES:
        return None, f"Priority must be one of: {', '.join(PRIORITIES)}."
    return priority, None


def validate_due_date(value):
    """Return (due_date, error). Empty input means 'no due date'."""
    if value is None or str(value).strip() == "":
        return None, None
    text = str(value).strip()
    if len(text) != 10:
        return None, "Due date must look like YYYY-MM-DD."
    try:
        date.fromisoformat(text)
    except ValueError:
        return None, "Due date must look like YYYY-MM-DD."
    return text, None


# --------------------------------------------------------------------------- #
# Serialisation
# --------------------------------------------------------------------------- #
def task_to_dict(row):
    return {
        "id": row["id"],
        "title": row["title"],
        "completed": bool(row["completed"]),
        "priority": row["priority"],
        "due_date": row["due_date"],
        "created_at": row["created_at"],
    }


def all_tasks():
    """Ordered for the UI: open before done, then High > Medium > Low, then the
    soonest due date first (undated tasks last, newest first)."""
    rows = get_db().execute(
        """
        SELECT id, title, completed, priority, due_date, created_at
        FROM tasks
        ORDER BY
            completed ASC,
            CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
            due_date IS NULL,
            due_date ASC,
            id DESC
        """
    ).fetchall()
    return [task_to_dict(row) for row in rows]


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/healthz")
def healthz():
    """Report where the data lives and whether it can be used.

    A deployed Function that answers 500 says nothing about why; this says which
    database file the app picked, whether it is writable, and how many tasks it
    can see.
    """
    payload = {
        "status": "ok",
        "database": str(DATABASE),
        "writable": database_writable(),
        "runtime": platform.python_version(),
        "platform": "vercel" if os.environ.get("VERCEL") else "local",
    }
    try:
        count = get_db().execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
    except (OSError, sqlite3.Error) as exc:
        payload.update(status="error", error=str(exc))
        return jsonify(payload), 503
    payload["tasks"] = count
    return jsonify(payload)


@app.route("/tasks", methods=["GET"])
def list_tasks():
    return jsonify(all_tasks())


@app.route("/tasks", methods=["POST"])
def add_task():
    payload = request.get_json(silent=True) or {}

    title, error = validate_title(payload.get("title"))
    if error:
        return jsonify({"error": error}), 400

    priority, error = validate_priority(payload.get("priority"))
    if error:
        return jsonify({"error": error}), 400

    due_date, error = validate_due_date(payload.get("due_date"))
    if error:
        return jsonify({"error": error}), 400

    db = get_db()
    db.execute(
        "INSERT INTO tasks (title, priority, due_date) VALUES (?, ?, ?)",
        (title, priority, due_date),
    )
    db.commit()
    return jsonify(all_tasks()), 201


@app.route("/tasks/<int:task_id>", methods=["PATCH"])
def update_task(task_id):
    """Edit a task. Send any of: title, priority, due_date."""
    payload = request.get_json(silent=True) or {}
    fields = {}

    if "title" in payload:
        title, error = validate_title(payload.get("title"))
        if error:
            return jsonify({"error": error}), 400
        fields["title"] = title

    if "priority" in payload:
        priority, error = validate_priority(payload.get("priority"))
        if error:
            return jsonify({"error": error}), 400
        fields["priority"] = priority

    if "due_date" in payload:
        due_date, error = validate_due_date(payload.get("due_date"))
        if error:
            return jsonify({"error": error}), 400
        fields["due_date"] = due_date

    if not fields:
        return jsonify({"error": "Nothing to update."}), 400

    db = get_db()
    assignments = ", ".join(f"{name} = ?" for name in fields)   # whitelisted keys
    cur = db.execute(
        f"UPDATE tasks SET {assignments} WHERE id = ?",
        (*fields.values(), task_id),
    )
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "Task not found."}), 404
    return jsonify(all_tasks())


@app.route("/tasks/<int:task_id>/toggle", methods=["POST"])
def toggle_task(task_id):
    db = get_db()
    cur = db.execute(
        "UPDATE tasks SET completed = 1 - completed WHERE id = ?", (task_id,)
    )
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "Task not found."}), 404
    return jsonify(all_tasks())


@app.route("/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id):
    db = get_db()
    cur = db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "Task not found."}), 404
    return jsonify(all_tasks())


@app.errorhandler(sqlite3.Error)
def database_error(exc):
    """Answer a database failure with 503 and a hint instead of an opaque 500."""
    log.error("Database error on %s: %s", DATABASE, exc)
    return jsonify({
        "error": "Database unavailable.",
        "detail": str(exc),
        "database": str(DATABASE),
        "hint": "Point ZURATASKS_DB at a writable path, or move off SQLite on "
                "serverless (see 'Deploying to Vercel' in the README).",
    }), 503


@app.cli.command("init-db")
def init_db_command():
    """Run with: flask --app app init-db"""
    init_db()
    print(f"Initialised database at {DATABASE}")


# Tables are created on first import so the app just works with `python app.py`.
# A database that cannot be created (a read-only deployment directory is what
# broke Vercel) must not take the whole Function down: log it, and let the
# request path answer 503 with the reason instead of an opaque 500.
try:
    init_db()
except (OSError, sqlite3.Error) as exc:
    log.warning("Database at %s is not usable: %s", DATABASE, exc)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
