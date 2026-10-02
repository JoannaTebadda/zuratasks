/* ZuraTasks. Every task lives in this browser's localStorage: on Vercel a
   Function can only write to /tmp, which is per-instance and wiped on a cold
   start, so neither a file nor SQLite can hold the list. Priority sections, the
   calendar, the filters and the search are views of that one array. */

const CACHE_KEY = "zuratasks.snapshot";   // the store: the whole task list
const THEME_KEY = "zuratasks.theme";      // remembers the dark mode choice

const PRIORITIES = ["high", "medium", "low"];
const PRIORITY_LABEL = { high: "High", medium: "Medium", low: "Low" };
const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_NAMES = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/* Empty-state artwork, inlined so the page still needs no extra files. */
const EMPTY_ICON = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"',
    ' stroke-linecap="round" stroke-linejoin="round" width="42" height="42">',
    '<rect x="4" y="3.5" width="16" height="17" rx="3"></rect>',
    '<path d="M8.5 12l2.4 2.4L16 9.5"></path></svg>',
].join("");

/* Chevron for the details panel, inlined like the other artwork. */
const CHEVRON_ICON = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"',
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    '<path d="M6 9.5l6 6 6-6"></path></svg>',
].join("");

/* Shown on a card whose task has a note. */
const NOTE_ICON = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"',
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    '<path d="M6 3.5h8.5L19 8v12.5H6z"></path><path d="M14 3.5V8h5"></path>',
    '<path d="M9 12.5h6M9 16h4"></path></svg>',
].join("");

const form        = document.getElementById("add-form");
const input       = document.getElementById("add-input");
const priorityEl  = document.getElementById("add-priority");
const dueEl       = document.getElementById("add-due");
const groupsEl    = document.getElementById("groups");
const empty       = document.getElementById("empty");
const count       = document.getElementById("count");
const errorEl     = document.getElementById("error");
const gridEl      = document.getElementById("calendar-grid");
const calTitle    = document.getElementById("calendar-title");
const prevBtn     = document.getElementById("prev-month");
const nextBtn     = document.getElementById("next-month");
const clearBtn    = document.getElementById("clear-filter");
const tabsEl      = document.getElementById("tabs");
const searchEl    = document.getElementById("search");
const progressEl  = document.getElementById("progress");
const progressBar = document.getElementById("progress-bar");
const themeBtn    = document.getElementById("theme-toggle");
const metaTheme   = document.getElementById("theme-color");
const toastsEl    = document.getElementById("toasts");
const greetingEl  = document.getElementById("greeting");

let subtaskSeq = 0;           // last subtask id handed out (ensureIds seeds it)
const entering = new Set();   // ids to fade in on the next paint
const expanded = new Set();   // ids of cards with the details panel open

let tasks = ensureIds(readCache());
let selectedDate = null;      // "YYYY-MM-DD" day picked in the calendar, or null
let editingId = null;         // id of the task open in the inline editor
let focusEditor = false;      // jump into the title field on the next paint
let filter = "all";           // all | today | upcoming | done
let query = "";               // search text, lower-cased
let canStore = true;          // false once localStorage refuses a write

const today = new Date();
const view = { year: today.getFullYear(), month: today.getMonth() };

/* ------------------------------ date helpers ------------------------------ */
function iso(dateObj) {
    const month = String(dateObj.getMonth() + 1).padStart(2, "0");
    const day = String(dateObj.getDate()).padStart(2, "0");
    return `${dateObj.getFullYear()}-${month}-${day}`;
}

function shiftIso(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return iso(d);
}

function humanDate(stamp) {
    if (stamp === iso(new Date())) return "Today";
    if (stamp === shiftIso(1)) return "Tomorrow";
    if (stamp === shiftIso(-1)) return "Yesterday";
    const [year, month, day] = stamp.split("-").map(Number);
    const label = new Date(year, month - 1, day).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
    });
    return year === new Date().getFullYear() ? label : `${label} ${year}`;
}

function isOverdue(task) {
    return Boolean(task.due_date) && !task.completed && task.due_date < iso(new Date());
}

/* -------------------------------- storage -------------------------------- */
/* localStorage is the only store, so both directions are guarded: private
   browsing, a full quota or blocked storage must never break the page. */
/* A subtask: its own text and tick, with an id unique across the whole store. */
function normaliseSubtask(raw) {
    if (!raw || typeof raw.text !== "string" || !raw.text.trim()) return null;
    return {
        id: Number.isFinite(raw.id) ? Math.trunc(raw.id) : 0,
        text: raw.text.trim().slice(0, 200),
        done: Boolean(raw.done),
    };
}

/* Lists saved before subtasks or notes existed have no fields at all, so both
   default to empty and those tasks load exactly as they did before. */
function normalise(task) {
    if (!task || typeof task.title !== "string" || !task.title.trim()) return null;
    return {
        id: Number.isFinite(task.id) ? Math.trunc(task.id) : 0,
        title: task.title.trim().slice(0, 200),
        completed: Boolean(task.completed),
        priority: PRIORITIES.includes(task.priority) ? task.priority : "medium",
        due_date: /^\d{4}-\d{2}-\d{2}$/.test(task.due_date) ? task.due_date : null,
        created_at: typeof task.created_at === "string" ? task.created_at : "",
        subtasks: Array.isArray(task.subtasks)
            ? task.subtasks.map(normaliseSubtask).filter(Boolean)
            : [],
        notes: typeof task.notes === "string" ? task.notes.slice(0, 4000) : "",
    };
}

/* Hand a fresh id to anything the stored list is missing or reusing. Task ids
   and subtask ids are each unique across the whole store. */
function ensureIds(list) {
    const seenTasks = new Set();
    const seenSubs = new Set();
    let maxTask = 0;
    let maxSub = subtaskSeq;
    for (const task of list) {
        if (task.id > 0 && !seenTasks.has(task.id)) {
            seenTasks.add(task.id);
            maxTask = Math.max(maxTask, task.id);
        } else {
            task.id = 0;                      // claimed again just below
        }
        for (const sub of task.subtasks) {
            if (sub.id > 0 && !seenSubs.has(sub.id)) {
                seenSubs.add(sub.id);
                maxSub = Math.max(maxSub, sub.id);
            } else {
                sub.id = 0;
            }
        }
    }
    for (const task of list) {
        if (task.id === 0) task.id = ++maxTask;
        for (const sub of task.subtasks) {
            if (sub.id === 0) sub.id = ++maxSub;
        }
    }
    subtaskSeq = maxSub;                      // so new subtasks never reuse an id
    return list;
}

function readCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalise).filter(Boolean);
    } catch {
        /* Unreadable or corrupt: start from an empty list rather than crash. */
        return [];
    }
}

function writeCache() {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(tasks));
        return true;
    } catch {
        /* Blocked or full. Keep the session usable in memory and say so once,
           instead of throwing on every single change. */
        if (canStore) {
            canStore = false;
            showError("This browser is not saving tasks (private mode or full " +
                      "storage). They will reset when the page is reloaded.");
        }
        return false;
    }
}

/* Every change goes through here: persist first, then repaint. */
function commit() {
    writeCache();
    render();
}

/* -------------------------------- messages -------------------------------- */
function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    form.classList.remove("add--invalid");
    void form.offsetWidth;                    // restart the shake animation
    form.classList.add("add--invalid");
}

function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = "";
    form.classList.remove("add--invalid");
    input.removeAttribute("aria-invalid");
}

/* Small confirmation after adding, completing or deleting a task. */
function toast(message, kind = "info") {
    const el = document.createElement("div");
    el.className = `toast toast--${kind}`;
    el.setAttribute("role", "status");
    el.textContent = message;
    toastsEl.appendChild(el);
    while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
    setTimeout(() => el.classList.add("toast--leaving"), 2400);
    setTimeout(() => el.remove(), 2700);
}

/* ------------------------------ what is shown ----------------------------- */
/* Soonest due date first, never-dated tasks last, newest task first on a tie. */
function byDueDate(a, b) {
    if (a.due_date && b.due_date) {
        if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
    } else if (a.due_date || b.due_date) {
        return a.due_date ? -1 : 1;
    }
    return b.id - a.id;
}

function matchesFilter(task) {
    if (filter === "done") return task.completed;
    if (filter === "today") return task.due_date === iso(new Date());
    if (filter === "upcoming") {
        return !task.completed && Boolean(task.due_date) && task.due_date > iso(new Date());
    }
    return true;                              // "all"
}

/* Matches the title, any subtask text, and the notes. */
function matchesSearch(task) {
    if (query === "") return true;
    return task.title.toLowerCase().includes(query) ||
        task.subtasks.some((sub) => sub.text.toLowerCase().includes(query)) ||
        task.notes.toLowerCase().includes(query);
}

/* The list shows: day filter, then tab, then search, sorted inside a section. */
function visibleTasks() {
    return tasks
        .filter((t) => !selectedDate || t.due_date === selectedDate)
        .filter(matchesFilter)
        .filter(matchesSearch)
        .sort(byDueDate);
}

/* --------------------------------- render --------------------------------- */
function render() {
    renderGroups();
    renderCalendar();
    renderCount();
    renderGreeting();
}

/* "Good morning · Wednesday, 30 September". The date is assembled by hand so
   the day reads before the month whatever the browser's locale is. */
function renderGreeting() {
    const now = new Date();
    const hour = now.getHours();
    const part = hour < 12 ? "Good morning"
        : hour < 18 ? "Good afternoon"
            : "Good evening";
    const stamp = `${WEEKDAY_NAMES[now.getDay()]}, ${now.getDate()} ` +
        MONTH_NAMES[now.getMonth()];
    greetingEl.textContent = `${part} \u00b7 ${stamp}`;
}

/* "1 of 2 done · 50%" beside the bar; "All done!" and a green fill at 100%. */
function renderCount() {
    const done = tasks.filter((t) => t.completed).length;
    const overdue = tasks.filter(isOverdue).length;
    const percent = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    const finished = tasks.length > 0 && done === tasks.length;

    if (tasks.length === 0) {
        count.textContent = "No tasks yet";
    } else if (finished) {
        count.textContent = `All done! \u00b7 ${done} of ${tasks.length} done \u00b7 100%`;
    } else {
        const parts = [`${done} of ${tasks.length} done`, `${percent}%`];
        if (overdue > 0) parts.push(`${overdue} overdue`);
        count.textContent = parts.join(" \u00b7 ");
    }

    progressEl.classList.toggle("progress--full", finished);
    progressEl.setAttribute("aria-valuemax", String(tasks.length));
    progressEl.setAttribute("aria-valuenow", String(done));
    progressEl.setAttribute("aria-valuetext",
        tasks.length === 0
            ? "No tasks yet"
            : `${done} of ${tasks.length} done, ${percent}%`);
    progressBar.style.width = `${percent}%`;
}

/* Explains an empty list instead of leaving a blank column. */
function emptyMessage() {
    if (tasks.length === 0) return "Nothing here yet. Add your first task above.";
    if (query) return `No tasks match \u201c${query}\u201d.`;
    if (selectedDate) return `Nothing is due on ${humanDate(selectedDate)}.`;
    if (filter === "today") return "Nothing due today. Enjoy the quiet.";
    if (filter === "upcoming") return "Nothing planned ahead. Add a due date to fill this up.";
    if (filter === "done") return "No finished tasks yet. Tick one off and it lands here.";
    return "No tasks to show.";
}

function renderEmpty() {
    empty.textContent = "";
    const icon = document.createElement("span");
    icon.className = "empty__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = EMPTY_ICON;
    const text = document.createElement("span");
    text.className = "empty__text";
    text.textContent = emptyMessage();
    empty.append(icon, text);
    empty.hidden = false;
}

/* Three fixed sections so the grouping is always visible, even when empty. */
function renderGroups() {
    groupsEl.textContent = "";
    const visible = visibleTasks();           // already sorted by due date

    if (visible.length === 0) {
        renderEmpty();
    } else {
        empty.hidden = true;
    }

    for (const priority of PRIORITIES) {
        groupsEl.appendChild(
            createGroup(priority, visible.filter((t) => t.priority === priority))
        );
    }
}

function createGroup(priority, items) {
    const section = document.createElement("section");
    section.className = `group group--${priority}`;

    const head = document.createElement("header");
    head.className = "group__head";

    const dot = document.createElement("span");
    dot.className = `dot dot--${priority}`;

    const name = document.createElement("h2");
    name.className = "group__name";
    name.textContent = `${PRIORITY_LABEL[priority]} priority`;

    const badge = document.createElement("span");
    badge.className = "group__count";
    badge.textContent = String(items.length);
    badge.title = `${items.length} ${PRIORITY_LABEL[priority]} priority task(s)`;

    head.append(dot, name, badge);
    section.appendChild(head);

    if (items.length === 0) {
        const none = document.createElement("p");
        none.className = "group__none";
        none.textContent = "No tasks";
        section.appendChild(none);
        return section;
    }

    const list = document.createElement("ul");
    list.className = "list";
    for (const task of items) {
        list.appendChild(task.id === editingId ? createEditor(task) : createItem(task));
    }
    section.appendChild(list);
    return section;
}

/* A card: priority stripe, checkbox, title, badges, Edit and Delete. */
function createItem(task) {
    const li = document.createElement("li");
    li.className = `item item--${task.priority}`;
    if (task.completed) li.classList.add("item--done");
    if (entering.delete(task.id)) li.classList.add("item--enter");
    li.dataset.id = String(task.id);

    const check = document.createElement("button");
    check.type = "button";
    check.className = "item__check";
    check.setAttribute("role", "checkbox");
    check.setAttribute("aria-checked", String(Boolean(task.completed)));
    check.setAttribute(
        "aria-label",
        `${task.completed ? "Mark incomplete" : "Mark complete"}: ${task.title}`
    );
    check.addEventListener("click", () => toggle(task));

    const body = document.createElement("div");
    body.className = "item__body";

    const title = document.createElement("span");
    title.className = "item__title";
    title.textContent = task.title;

    const meta = document.createElement("span");
    meta.className = "item__meta";

    const badge = document.createElement("span");
    badge.className = `chip chip--prio chip--${task.priority}`;
    badge.textContent = PRIORITY_LABEL[task.priority];

    /* Compact counts for the collapsed card; the panel keeps them in step. */
    const subChip = document.createElement("span");
    subChip.className = "chip chip--subs";

    const noteChip = document.createElement("span");
    noteChip.className = "chip chip--note";
    noteChip.innerHTML = NOTE_ICON;
    noteChip.title = "Has notes";

    meta.append(badge, subChip, noteChip);

    if (task.due_date) {
        const overdue = isOverdue(task);
        const soon = !task.completed && task.due_date <= shiftIso(1);
        const stamp = `Due ${humanDate(task.due_date)}`;
        if (overdue || !soon) {
            const date = document.createElement("span");
            date.className = "item__date";
            if (overdue) date.classList.add("item__date--overdue");
            date.textContent = stamp;
            date.title = `Due ${task.due_date}`;
            meta.appendChild(date);
        } else {
            const chip = document.createElement("span");
            chip.className = "chip chip--today";
            chip.textContent = stamp;
            chip.title = `Due ${task.due_date}`;
            meta.appendChild(chip);
        }
        if (overdue) {
            const late = document.createElement("span");
            late.className = "chip chip--overdue";
            late.textContent = "Overdue";
            meta.appendChild(late);
        }
    }

    body.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "item__actions";

    const chevron = document.createElement("button");
    chevron.type = "button";
    chevron.className = "item__toggle";
    chevron.innerHTML = CHEVRON_ICON;
    chevron.setAttribute("aria-expanded", "false");
    chevron.setAttribute("aria-controls", `panel-${task.id}`);
    chevron.setAttribute("aria-label", `Subtasks and notes for ${task.title}`);
    chevron.title = "Show subtasks";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "item__edit";
    edit.textContent = "\u270e Edit";
    edit.title = "Edit task";
    edit.setAttribute("aria-label", `Edit: ${task.title}`);
    edit.addEventListener("click", () => {
        editingId = task.id;
        focusEditor = true;
        render();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "item__delete";
    del.textContent = "\u00d7 Delete";
    del.title = "Delete task";
    del.setAttribute("aria-label", `Delete: ${task.title}`);
    del.addEventListener("click", () => remove(task, li));

    actions.append(chevron, edit, del);
    li.append(check, body, actions);
    li.appendChild(createPanel(task, { li, toggleBtn: chevron, subChip, noteChip }));
    return li;
}

/* ----------------------------- details panel ------------------------------ */
/* Subtasks live in this collapsible panel; each id is unique across the store. */
function nextSubtaskId() {
    subtaskSeq += 1;
    return subtaskSeq;
}

/* The chevron opens this. It slides via a max-height transition, and
   `expanded` keeps the open cards open across re-renders. */
function createPanel(task, ui) {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.id = `panel-${task.id}`;
    panel.style.maxHeight = "0px";                 // collapsed by default

    const inner = document.createElement("div");
    inner.className = "panel__inner";

    /* ---- subtasks ---- */
    const section = document.createElement("section");
    section.className = "panel__section";

    const head = document.createElement("div");
    head.className = "panel__head";
    const heading = document.createElement("h3");
    heading.className = "panel__title";
    heading.textContent = "Subtasks";
    const tally = document.createElement("span");
    tally.className = "panel__count";
    head.append(heading, tally);

    const list = document.createElement("ul");
    list.className = "subs";

    const mini = document.createElement("div");
    mini.className = "mini";
    const miniBar = document.createElement("span");
    miniBar.className = "mini__bar";
    mini.appendChild(miniBar);

    const addForm = document.createElement("form");
    addForm.className = "subs__add";
    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.className = "subs__input";
    addInput.maxLength = 200;
    addInput.placeholder = "Add a subtask\u2026";
    addInput.setAttribute("aria-label", `New subtask for ${task.title}`);
    const addBtn = document.createElement("button");
    addBtn.type = "submit";
    addBtn.className = "subs__btn";
    addBtn.textContent = "Add subtask";
    addForm.append(addInput, addBtn);

    section.append(head, list, mini, addForm);
    inner.appendChild(section);

    /* ---- notes ---- */
    const notesSection = document.createElement("section");
    notesSection.className = "panel__section";

    const notesHead = document.createElement("div");
    notesHead.className = "panel__head";
    const notesTitle = document.createElement("h3");
    notesTitle.className = "panel__title";
    notesTitle.textContent = "Notes";
    const saved = document.createElement("span");
    saved.className = "notes__saved";
    saved.setAttribute("role", "status");
    saved.textContent = "Saved";
    notesHead.append(notesTitle, saved);

    const notesArea = document.createElement("textarea");
    notesArea.className = "notes__area";
    notesArea.placeholder = "Add notes...";
    notesArea.rows = 3;
    notesArea.maxLength = 4000;
    notesArea.value = task.notes;
    notesArea.setAttribute("aria-label", `Notes for ${task.title}`);

    notesSection.append(notesHead, notesArea);
    inner.appendChild(notesSection);
    panel.appendChild(inner);

    /* Keep the mini bar, the tally and the card badge in step after a change. */
    function sync() {
        const total = task.subtasks.length;
        const done = task.subtasks.filter((sub) => sub.done).length;
        tally.textContent = total === 0 ? "none yet" : `${done} of ${total}`;
        mini.hidden = total === 0;
        miniBar.style.width = total === 0 ? "0%" : `${Math.round((done / total) * 100)}%`;
        ui.subChip.hidden = total === 0;
        ui.subChip.textContent = `${done}/${total}`;
        ui.subChip.title = `${done} of ${total} subtasks done`;
    }

    /* One subtask row: tick, text, small delete. Built here so adding or
       removing one never rebuilds the list (which would close the panels). */
    function buildRow(sub) {
        const row = document.createElement("li");
        row.className = "sub";
        row.dataset.id = String(sub.id);
        if (sub.done) row.classList.add("sub--done");

        const tick = document.createElement("button");
        tick.type = "button";
        tick.className = "sub__check";
        tick.setAttribute("role", "checkbox");
        tick.setAttribute("aria-checked", String(sub.done));
        tick.setAttribute("aria-label", `Subtask: ${sub.text}`);
        tick.addEventListener("click", () => tickSubtask(sub, row, tick));

        const text = document.createElement("span");
        text.className = "sub__text";
        text.textContent = sub.text;

        const drop = document.createElement("button");
        drop.type = "button";
        drop.className = "sub__delete";
        drop.textContent = "\u00d7";
        drop.title = "Delete subtask";
        drop.setAttribute("aria-label", `Delete subtask: ${sub.text}`);
        drop.addEventListener("click", () => dropSubtask(sub, row));

        row.append(tick, text, drop);
        return row;
    }

    /* Ticking a subtask is its own change. Finishing the last one only offers
       to close the task; it never does that on its own. */
    function tickSubtask(sub, row, tick) {
        sub.done = !sub.done;
        row.classList.toggle("sub--done", sub.done);
        tick.setAttribute("aria-checked", String(sub.done));
        writeCache();
        sync();
        if (sub.done && task.subtasks.every((item) => item.done) && !task.completed) {
            const markDone = typeof window.confirm === "function"
                ? window.confirm(
                    `All subtasks are done. Mark \u201c${task.title}\u201d as done?`)
                : false;
            if (markDone) {
                task.completed = true;        // the subtasks are left as they are
                commit();
                toast(`Done: ${task.title}`, "success");
                return;
            }
        }
        toast(sub.done ? "Subtask ticked" : "Subtask unticked",
            sub.done ? "success" : "info");
    }

    function dropSubtask(sub, row) {
        leave(row, () => {
            task.subtasks = task.subtasks.filter((item) => item.id !== sub.id);
            writeCache();
            row.remove();
            sync();
            toast("Subtask deleted", "warn");
        }, "sub--leaving");
    }

    /* Enter in the field submits the form, so both routes land here. */
    addForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = addInput.value.trim();
        if (!text) {
            toast("A subtask needs a few words", "warn");
            addInput.focus();
            return;
        }
        const sub = { id: nextSubtaskId(), text: text.slice(0, 200), done: false };
        task.subtasks.push(sub);
        writeCache();
        list.appendChild(buildRow(sub));
        sync();
        addInput.value = "";
        addInput.focus();
        toast("Subtask added", "success");
    });

    /* Notes save themselves half a second after you stop typing. The box grows
       with the text, and the card badge appears as soon as there is a note. */
    let notesTimer = null;
    let savedTimer = null;

    function syncNote() {
        const has = task.notes.trim() !== "";
        ui.noteChip.hidden = !has;
        ui.noteChip.title = has ? "Has notes" : "";
    }

    function growNotes() {
        notesArea.style.height = "auto";
        notesArea.style.height = `${Math.max(76, notesArea.scrollHeight)}px`;
    }

    notesArea.addEventListener("input", () => {
        task.notes = notesArea.value.slice(0, 4000);
        growNotes();
        syncNote();
        saved.textContent = "Saving\u2026";
        saved.classList.add("notes__saved--on");
        clearTimeout(notesTimer);
        clearTimeout(savedTimer);
        notesTimer = setTimeout(() => {
            writeCache();
            saved.textContent = "Saved";
            savedTimer = setTimeout(() => saved.classList.remove("notes__saved--on"), 1600);
        }, 500);
    });

    syncNote();

    /* ---- open and close ---- */
    /* The inner box is never clipped itself, so its height is the true height
       to animate to, whatever the panel's current max-height is. Once the slide
       has run the height is handed back to the content, so adding a subtask or
       growing the notes can never be clipped. The timer covers a browser that
       fires no transitionend (a hidden tab, or animations turned off). */
    function openPanel() {
        expanded.add(task.id);
        ui.li.classList.add("item--open");
        ui.toggleBtn.setAttribute("aria-expanded", "true");
        panel.style.maxHeight = `${inner.offsetHeight}px`;
        growNotes();                          // show a long note in full
        setTimeout(freeHeight, 320);
    }

    function freeHeight() {
        if (expanded.has(task.id)) panel.style.maxHeight = "none";
    }

    function closePanel() {
        expanded.delete(task.id);
        ui.li.classList.remove("item--open");
        ui.toggleBtn.setAttribute("aria-expanded", "false");
        panel.style.maxHeight = `${inner.offsetHeight}px`;   // measure before closing
        void panel.offsetHeight;                             // let that land first
        panel.style.maxHeight = "0px";
    }

    ui.toggleBtn.addEventListener("click", () => {
        if (expanded.has(task.id)) closePanel();
        else openPanel();
    });

    /* Fully open, the height is left to the content so a new subtask is never
       clipped; closing measures it again first. */
    panel.addEventListener("transitionend", (event) => {
        if (event.target === panel && expanded.has(task.id)) freeHeight();
    });

    for (const sub of task.subtasks) list.appendChild(buildRow(sub));
    sync();

    if (expanded.has(task.id)) {                 // a re-render of an open card
        ui.li.classList.add("item--open");
        ui.toggleBtn.setAttribute("aria-expanded", "true");
        panel.style.maxHeight = "none";
    }
    return panel;
}

/* Fade a row out, then apply the change; the timer covers "no animation". */
function leave(el, finish, className = "item--leaving") {
    if (!el) {
        finish();
        return;
    }
    el.classList.add(className);
    let done = false;
    const once = () => {
        if (done) return;
        done = true;
        finish();
    };
    el.addEventListener("animationend", once);
    setTimeout(once, 320);
}

function createEditor(task) {
    const li = document.createElement("li");
    li.className = `item item--editing item--${task.priority}`;
    li.dataset.id = String(task.id);

    const title = document.createElement("input");
    title.type = "text";
    title.value = task.title;
    title.maxLength = 200;
    title.setAttribute("aria-label", "Task title");

    const priority = document.createElement("select");
    priority.setAttribute("aria-label", "Priority");
    for (const value of PRIORITIES) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = PRIORITY_LABEL[value];
        option.selected = value === task.priority;
        priority.appendChild(option);
    }

    const due = document.createElement("input");
    due.type = "date";
    due.value = task.due_date || "";
    due.setAttribute("aria-label", "Due date");

    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-mini btn-mini--save";
    save.textContent = "Save";
    save.addEventListener("click", () => {
        if (!title.value.trim()) {
            title.setAttribute("aria-invalid", "true");
            showError("A task needs a title \u2014 type one, or press Cancel.");
            title.focus();
            return;
        }
        title.removeAttribute("aria-invalid");
        saveEdit(task, {
            title: title.value,
            priority: priority.value,
            due_date: due.value,
        });
    });

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-mini";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
        editingId = null;
        render();
    });

    li.addEventListener("keydown", (event) => {
        if (event.target.tagName === "BUTTON") return;   // let the buttons handle it
        if (event.key === "Enter") save.click();
        if (event.key === "Escape") cancel.click();
    });

    li.append(title, priority, due, save, cancel);

    if (focusEditor) {                        // opened from the Edit button
        focusEditor = false;
        setTimeout(() => title.focus(), 0);
    }
    return li;
}

function renderCalendar() {
    const { year, month } = view;
    calTitle.textContent = `${MONTH_NAMES[month]} ${year}`;
    gridEl.textContent = "";

    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
    const todayStamp = iso(new Date());

    for (let cell = 0; cell < cells; cell += 1) {
        const dateObj = new Date(year, month, cell - firstWeekday + 1);
        const stamp = iso(dateObj);
        const due = tasks.filter((t) => t.due_date === stamp);

        const day = document.createElement("button");
        day.type = "button";
        day.className = "day";
        if (dateObj.getMonth() !== month) day.classList.add("day--muted");
        if (stamp === todayStamp) day.classList.add("day--today");
        if (stamp === selectedDate) day.classList.add("day--selected");
        if (due.length > 0) {
            day.classList.add("day--has");
            if (due.some((t) => isOverdue(t))) day.classList.add("day--overdue");
            if (due.every((t) => t.completed)) day.classList.add("day--clear");
        }
        day.setAttribute(
            "aria-label",
            due.length > 0 ? `${stamp}: ${due.length} task(s) due` : stamp
        );
        day.setAttribute("aria-pressed", String(stamp === selectedDate));
        day.title = due.length > 0 ? `${due.length} task(s) due` : "";

        const num = document.createElement("span");
        num.className = "day__num";
        num.textContent = String(dateObj.getDate());
        day.appendChild(num);

        if (due.length > 0) {
            const dots = document.createElement("span");
            dots.className = "day__dots";
            for (const task of due.slice(0, 3)) {
                const dot = document.createElement("span");
                dot.className = `dot dot--${task.priority}`;
                dots.appendChild(dot);
            }
            day.appendChild(dots);
        }

        day.addEventListener("click", () => selectDate(stamp));
        gridEl.appendChild(day);
    }

    clearBtn.hidden = !selectedDate;
    if (selectedDate) {
        clearBtn.textContent = `Showing ${humanDate(selectedDate)} \u2014 clear`;
    }
}

/* Clicking the same day again clears the filter; picking a day shows every tab
   so the day you clicked is never filtered out by the tab underneath it. */
function selectDate(stamp) {
    selectedDate = selectedDate === stamp ? null : stamp;
    editingId = null;
    if (selectedDate && filter !== "all") {
        filter = "all";
        syncTabs();
    }
    render();
}

function stepMonth(delta) {
    const moved = new Date(view.year, view.month + delta, 1);
    view.year = moved.getFullYear();
    view.month = moved.getMonth();
    renderCalendar();
}

/* ------------------------------- changes ---------------------------------- */
function nextId() {
    return tasks.reduce((max, task) => Math.max(max, task.id), 0) + 1;
}

/* Keeps the tab buttons in step with the active filter. */
function syncTabs() {
    for (const tab of tabsEl.children) {
        const active = (tab.dataset.filter || "all") === filter;
        tab.classList.toggle("tab--active", active);
        tab.setAttribute("aria-pressed", String(active));
    }
}

/* A brand new task must never land invisibly: drop whatever would hide it. */
function ensureVisible(task) {
    let changed = false;
    if (!matchesFilter(task)) {
        filter = "all";
        changed = true;
    }
    if (query && !matchesSearch(task)) {
        query = "";
        searchEl.value = "";
        changed = true;
    }
    if (selectedDate && task.due_date !== selectedDate) {
        selectedDate = null;
        changed = true;
    }
    if (changed) {
        syncTabs();
        render();
    }
}

function add(payload) {
    const task = {
        id: nextId(),
        title: payload.title.trim().slice(0, 200),
        completed: false,
        priority: PRIORITIES.includes(payload.priority) ? payload.priority : "medium",
        due_date: payload.due_date || null,
        created_at: new Date().toISOString(),
        subtasks: [],                 // filled in from the details panel
        notes: "",                    // ditto
    };
    tasks.push(task);
    entering.add(task.id);          // fade this one card in on the next paint
    commit();
    ensureVisible(task);
    toast(`Added: ${task.title}`, "success");
    return task;
}

/* Ticking the card by hand never touches its subtasks: they stay as they are. */
function toggle(task) {
    task.completed = !task.completed;
    commit();
    toast(
        task.completed ? `Done: ${task.title}` : `Back on the list: ${task.title}`,
        task.completed ? "success" : "info"
    );
}

/* Deleting always asks first, naming the subtasks it would take with it. */
function remove(task, li) {
    const subs = task.subtasks.length;
    const extra = subs === 0 ? ""
        : subs === 1 ? " and its 1 subtask"
            : ` and its ${subs} subtasks`;
    const ask = typeof window.confirm === "function"
        ? window.confirm(`Delete \u201c${task.title}\u201d${extra}? This cannot be undone.`)
        : true;
    if (!ask) return;

    leave(li, () => {
        if (editingId === task.id) editingId = null;
        tasks = tasks.filter((t) => t.id !== task.id);
        commit();
        toast("Task deleted", "warn");
    });
}

function saveEdit(task, changes) {
    const title = changes.title.trim();
    if (!title) {
        showError("Task title cannot be empty.");
        return;
    }
    clearError();
    task.title = title.slice(0, 200);
    if (PRIORITIES.includes(changes.priority)) task.priority = changes.priority;
    task.due_date = changes.due_date || null;
    editingId = null;
    commit();
    toast("Task updated", "success");
}

/* Re-read the store: once at start-up, and whenever another tab writes to it. */
function refresh() {
    tasks = ensureIds(readCache());
    render();
}

/* ------------------------------- dark mode -------------------------------- */
function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const dark = theme === "dark";
    if (metaTheme) {
        metaTheme.setAttribute("content", dark ? "#150f24" : "#fbf8ff");
    }
    themeBtn.setAttribute("aria-pressed", String(dark));
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    themeBtn.setAttribute("aria-label", label);
    themeBtn.title = label;
}

function toggleTheme() {
    const dark = document.documentElement.dataset.theme === "dark";
    applyTheme(dark ? "light" : "dark");
    try {
        localStorage.setItem(THEME_KEY, dark ? "light" : "dark");   // remembered
    } catch {
        /* storage blocked: the choice still holds for this visit */
    }
}

/* --------------------------------- events --------------------------------- */
form.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) {
        input.setAttribute("aria-invalid", "true");
        showError("Please type a task first \u2014 a few words is plenty.");
        input.focus();
        return;
    }
    clearError();
    input.value = "";
    add({ title, priority: priorityEl.value, due_date: dueEl.value });
    input.focus();                            // ready for the next one
});

input.addEventListener("input", clearError);

tabsEl.addEventListener("click", (event) => {
    const tab = event.target.closest && event.target.closest("[data-filter]");
    if (!tab) return;
    filter = tab.dataset.filter || "all";
    editingId = null;
    syncTabs();
    render();
});

searchEl.addEventListener("input", () => {
    query = searchEl.value.trim().toLowerCase();   // filters the list as you type
    render();
});

themeBtn.addEventListener("click", toggleTheme);

prevBtn.addEventListener("click", () => stepMonth(-1));
nextBtn.addEventListener("click", () => stepMonth(1));
clearBtn.addEventListener("click", () => selectDate(selectedDate));

/* Another tab changed the list - show what it did. */
window.addEventListener("storage", (event) => {
    if (!event || event.key === CACHE_KEY) refresh();
});

/* Escape clears a validation message. */
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && errorEl.hidden === false) clearError();
});

/* Follow the operating system while no explicit choice has been saved. */
if (window.matchMedia) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const followSystem = () => {
        try {
            if (!localStorage.getItem(THEME_KEY)) {
                applyTheme(media.matches ? "dark" : "light");
            }
        } catch {
            /* storage blocked: keep the theme as it is */
        }
    };
    if (typeof media.addEventListener === "function") {
        media.addEventListener("change", followSystem);
    }
}

/* Keep the greeting honest if the page is left open past noon or midnight. */
setInterval(renderGreeting, 60000);

/* The page pre-set data-theme in the head; the rest paints from the store. */
applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
syncTabs();
refresh();
