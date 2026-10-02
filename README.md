# ZuraTasks &mdash; Flask + SQLite

A to-do app with **priority sections**, **due dates** and a **month calendar**.
Soft purple-and-pink theme on white, vanilla JS front end.

## Features

* **Priority sections.** Every task is High, Medium or Low priority, and the list
  is grouped into three labelled sections (High first) with a count per section.
  The heading, its dot and the left edge of each row are tinted to match.
* **Due dates.** Set a date when adding a task, or later with the pencil button.
  Dates read as `Today`, `Tomorrow`, `Yesterday` or `5 Oct`; open tasks past their
  date are flagged **Overdue** in rose and counted in the header.
* **Calendar.** The month grid marks every day that has something due, with one
  coloured dot per task (rose = high, violet = medium, teal = low). Today is
  outlined in purple, overdue days turn rose, and clicking a day filters the list
  to what is due that day. Click the day again, or the button under the calendar,
  to clear. `&lsaquo;` / `&rsaquo;` step through months.
* **Inline editing.** The pencil on a row swaps it for title, priority and date
  fields: `Enter` or **Save** applies the change, `Escape` or **Cancel** abandons
  it. The list the page draws is kept in the browser (see
  [How tasks are saved](#how-tasks-are-saved)), so saving needs no round trip.
* **Subtasks and notes.** The chevron on a card slides open a panel with the
  task's subtasks and notes. Subtasks are added with the button or `Enter`, get
  a tick and a small delete, and a mini bar shows how many are done; the card
  carries a `2/4` count and a note icon. Notes save themselves half a second
  after you stop typing, and the box grows with the text. Ticking the last
  subtask only *offers* to close the task, and deleting a task names the
  subtasks it would take with it.

## Priority and date rules

* Priority is one of `high`, `medium`, `low` (default `medium`); anything else is
  rejected with a 400.
* Due dates must be `YYYY-MM-DD`, stored as plain text, or empty / omitted for
  "no due date".
* Ordering: the three sections run High &rarr; Medium &rarr; Low, and inside each
  one the page sorts by due date, soonest first (undated tasks last, newest
  first). The API's own ordering, which `/tasks` returns, is open tasks first,
  then priority, then soonest due date.

## Run it

```bash
git clone https://github.com/JoannaTebadda/zuratasks.git
cd zuratasks
py -m pip install -r requirements.txt
py app.py
```

Then open <http://127.0.0.1:5000>. Use `python` instead of `py` if that launcher
is on your PATH.

Source: <https://github.com/JoannaTebadda/zuratasks>

`tasks.db` is created automatically next to `app.py` on first run, so there is
no separate migration step. Delete that file to start over.

A `tasks.db` from before priorities existed is upgraded in place on start-up: the
missing `priority` and `due_date` columns are added with `ALTER TABLE`, existing
rows become Medium priority with no due date, and nothing is deleted.

## Deploying to Vercel

Vercel's Flask preset works with no configuration: it looks for a Flask instance
named `app` in `app.py`, `index.py`, `server.py`, `main.py`, `wsgi.py` or
`asgi.py` at the project root (or under `src/`, `app/` or `api/`), finds this
one in `app.py`, and runs the whole app as a single Function. So there is no
`api/index.py` shim and no `vercel.json` to keep in sync &mdash; the file that
serves you locally is the file Vercel runs.

* `requirements.txt` pins `Flask==3.1.3`, the only runtime dependency
  (`sqlite3` is part of Python).
* `.python-version` asks for Python `3.12`, the version Vercel uses by default.
* `ZURATASKS_DB` chooses the database file. On Vercel the app automatically
  writes `/tmp/tasks.db`, because the directory holding the deployment is
  read-only and `/tmp` is the only writable place inside a Function; locally it
  stays `tasks.db` next to `app.py`.
* `GET /healthz` reports the database path, whether that path is writable, the
  Python version and the task count.

### The error this fixed

Every route answered `500 FUNCTION_INVOCATION_FAILED`, on `/` and `/tasks`
alike. The build was never the problem &mdash; the app died while being
imported, because it created its database next to `app.py`:

```text
File "/var/task/app.py", line 250, in <module>
    init_db()
File "/var/task/app.py", line 42, in init_db
    db = sqlite3.connect(DATABASE)
sqlite3.OperationalError: unable to open database file
```

The same code works in a writable directory, so the fix is to write where a
Function is allowed to write. `init_db()` is also no longer allowed to take the
whole Function down: if the database cannot be opened, the app still starts,
logs a warning, and `/healthz` plus the task routes answer `503` with the path
and the reason instead of a bare server error.

### Tasks on Vercel are not permanent

Vercel's own guidance is that SQLite "[can't be used with
Vercel](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel)": function
storage is ephemeral and each instance gets its own copy, so a redeploy, a cold
start or a second concurrent instance starts from an empty database and the
lists can disagree with each other. `/tmp` makes the app run and keeps it simple
for a demo, but a shared to-do list needs a hosted database &mdash; Vercel
Postgres, Neon, Turso and friends &mdash; wired in through `ZURATASKS_DB`-style
configuration and one more entry in `requirements.txt`.

Runtime errors are listed in the Vercel dashboard under the deployment's
**Logs** tab, or from a terminal with
`npx vercel logs <deployment-url>`. Each error page also prints a request ID
such as `cpt1::zf9n6-1790689381036-2051c0513e20`, which is what you search for
to find that single request in the log stream.

## How tasks are saved

The list lives in the browser. Ticking a task off on your phone will not change
your laptop's list, and the API below stays available for scripting.

* **`localStorage`** (`zuratasks.snapshot` key) is the store. Adding, ticking off,
  editing and deleting each write the whole list back to it, so tasks survive a
  refresh, a redeploy and a cold start. That is why it is used instead of a file
  or SQLite: a Vercel Function cannot keep either. Reads and writes are both
  wrapped in `try/catch`, so private browsing or a full quota leaves the app
  usable for the visit (it says so once) instead of throwing on every change.
  Each task is stored as `{id, title, completed, priority, due_date, created_at,
  subtasks: [{id, text, done}], notes}`. Lists saved before subtasks and notes
  existed have neither field: they load as an empty list and an empty string, so
  an older save keeps working. The search box matches the title, every subtask
  text and the notes.
* **SQLite (`tasks.db`)** now backs the JSON API and nothing else.
  `ZURATASKS_DB` moves the file (the app uses `/tmp/tasks.db` on Vercel); see
  [Deploying to Vercel](#deploying-to-vercel). To point the front end back at the
  API, replace `readCache` / `writeCache` in `static/app.js` with `fetch` calls:
  every route below already returns the full list.

## API

| Method | Route                   | Purpose              |
| ------ | ----------------------- | -------------------- |
| `GET`    | `/tasks`              | List all tasks       |
| `POST`   | `/tasks`              | Add a task (`title`, `priority`, `due_date`) |
| `PATCH`  | `/tasks/<id>`         | Edit `title` / `priority` / `due_date`   |
| `POST`   | `/tasks/<id>/toggle`  | Toggle completion    |
| `DELETE` | `/tasks/<id>`         | Delete a task        |
| `GET`    | `/healthz`            | Database path, writability, task count |

Every mutating route returns the full updated list, which keeps the client logic
small and self-correcting.
