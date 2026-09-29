"""ZuraTasks - a to-do list with priority groups, due dates and a calendar.

Backend: Flask + SQLite. Frontend: vanilla JS in static/app.js.
"""

import sqlite3
from datetime import date
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent
DATABASE = BASE_DIR / "tasks.db"

PRIORITIES = ("high", "medium", "low")
DEFAULT_PRIORITY = "medium"

app = Flask(__name__)


# --------------------------------------------------------------------------- #
# Database helpers
# --------------------------------------------------------------------------- #
def get_db():
    """Return a connection to the SQLite database, scoped to this request."""
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
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


@app.cli.command("init-db")
def init_db_command():
    """Run with: flask --app app init-db"""
    init_db()
    print(f"Initialised database at {DATABASE}")


# Tables are created on first import so the app just works with `python app.py`.
init_db()


if __name__ == "__main__":
    app.run(debug=True, port=5000)
