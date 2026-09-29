# ZuraTasks &mdash; Flask + SQLite

A to-do app with **priority sections**, **due dates** and a **month calendar**.
Dark theme, neon-green accent, vanilla JS front end.

## Features

* **Priority sections.** Every task is High, Medium or Low priority, and the list
  is grouped into three labelled sections (High first) with a count per section.
  The heading, its dot and the left edge of each row are tinted to match.
* **Due dates.** Set a date when adding a task, or later with the pencil button.
  Dates read as `Today`, `Tomorrow`, `Yesterday` or `5 Oct`; open tasks past their
  date are flagged **Overdue** in red and counted in the header.
* **Calendar.** The month grid marks every day that has something due, with one
  coloured dot per task (red = high, amber = medium, green = low). Today is
  outlined, overdue days turn red, and clicking a day filters the list to what is
  due that day. Click the day again, or the button under the calendar, to clear.
  `&lsaquo;` / `&rsaquo;` step through months.
* **Inline editing.** The pencil on a row swaps it for title, priority and date
  fields: `Enter` or **Save** applies the change via `PATCH /tasks/<id>`,
  `Escape` or **Cancel** abandons it.

## Priority and date rules

* Priority is one of `high`, `medium`, `low` (default `medium`); anything else is
  rejected with a 400.
* Due dates must be `YYYY-MM-DD`, stored as plain text, or empty / omitted for
  "no due date".
* Ordering comes from SQLite: open tasks first, then High &rarr; Medium &rarr; Low,
  then soonest due date (undated tasks last, newest first). The three sections are
  a client-side view of that order.

## Run it

```bash
cd "To do app"
py -m pip install -r requirements.txt
py app.py
```

Then open <http://127.0.0.1:5000>.

`tasks.db` is created automatically next to `app.py` on first run, so there is
no separate migration step. Delete that file to start over.

A `tasks.db` from before priorities existed is upgraded in place on start-up: the
missing `priority` and `due_date` columns are added with `ALTER TABLE`, existing
rows become Medium priority with no due date, and nothing is deleted.

## How tasks are saved

* **SQLite (`tasks.db`)** is the source of truth. Every add, toggle and delete is
  committed to it, so tasks survive a server restart and are shared by everyone
  who loads the page.
* **`localStorage`** (`zuratasks.snapshot` key) holds a snapshot of the last list the
  browser received. On reload the UI paints from it immediately, then replaces it
  with the authoritative list from `/tasks`. It is a cache for perceived speed,
  not the store &mdash; clearing browser storage never loses tasks.

## API

| Method | Route                   | Purpose              |
| ------ | ----------------------- | -------------------- |
| `GET`    | `/tasks`              | List all tasks       |
| `POST`   | `/tasks`              | Add a task (`title`, `priority`, `due_date`) |
| `PATCH`  | `/tasks/<id>`         | Edit `title` / `priority` / `due_date`   |
| `POST`   | `/tasks/<id>/toggle`  | Toggle completion    |
| `DELETE` | `/tasks/<id>`         | Delete a task        |

Every mutating route returns the full updated list, which keeps the client logic
small and self-correcting.
