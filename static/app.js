/* ZuraTasks. SQLite (via Flask) is the source of truth and localStorage holds a
   snapshot so the list paints instantly on reload while the fetch settles.
   Priority grouping and the calendar are pure client-side views of that one
   list, which keeps the API small. */

const CACHE_KEY = "zuratasks.snapshot";

const PRIORITIES = ["high", "medium", "low"];
const PRIORITY_LABEL = { high: "High", medium: "Medium", low: "Low" };
const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

const form       = document.getElementById("add-form");
const input      = document.getElementById("add-input");
const priorityEl = document.getElementById("add-priority");
const dueEl      = document.getElementById("add-due");
const groupsEl   = document.getElementById("groups");
const empty      = document.getElementById("empty");
const count      = document.getElementById("count");
const errorEl    = document.getElementById("error");
const gridEl     = document.getElementById("calendar-grid");
const calTitle   = document.getElementById("calendar-title");
const prevBtn    = document.getElementById("prev-month");
const nextBtn    = document.getElementById("next-month");
const clearBtn   = document.getElementById("clear-filter");

let tasks = readCache();
let selectedDate = null;      // "YYYY-MM-DD" day picked in the calendar, or null
let editingId = null;         // id of the task open in the inline editor

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

function readCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeCache() {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(tasks));
    } catch {
        /* storage full or blocked by privacy settings - server copy still rules */
    }
}

function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
}

function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = "";
}

/* Every mutating endpoint returns the full, up-to-date list. */
async function api(url, options = {}) {
    const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...options,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        throw new Error((body && body.error) || `Request failed (${res.status})`);
    }
    tasks = Array.isArray(body) ? body : [];
    writeCache();
    render();
}

function render() {
    renderGroups();
    renderCalendar();
    renderCount();
}

function renderCount() {
    if (tasks.length === 0) {
        count.textContent = "No tasks yet";
        return;
    }
    const done = tasks.filter((t) => t.completed).length;
    const overdue = tasks.filter(isOverdue).length;
    const parts = [`${done} of ${tasks.length} done`];
    if (overdue > 0) parts.push(`${overdue} overdue`);
    count.textContent = parts.join(" \u00b7 ");
}

function visibleTasks() {
    return selectedDate ? tasks.filter((t) => t.due_date === selectedDate) : tasks;
}

/* Three fixed sections so the grouping is always visible, even when empty. */
function renderGroups() {
    groupsEl.textContent = "";
    const visible = visibleTasks();

    empty.hidden = visible.length > 0;
    empty.textContent = selectedDate
        ? `No tasks due on ${humanDate(selectedDate)}.`
        : "Nothing here yet. Add your first task above.";

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

function createItem(task) {
    const li = document.createElement("li");
    li.className = task.completed ? "item item--done" : "item";

    const check = document.createElement("button");
    check.type = "button";
    check.className = "item__check";
    check.setAttribute(
        "aria-label",
        `${task.completed ? "Mark incomplete" : "Mark complete"}: ${task.title}`
    );
    check.addEventListener("click", () => toggle(task));

    const title = document.createElement("span");
    title.className = "item__title";
    title.textContent = task.title;

    li.append(check, title);

    if (task.due_date) {
        const overdue = isOverdue(task);
        const chip = document.createElement("span");
        chip.className = "chip";
        if (overdue) {
            chip.classList.add("chip--overdue");
            chip.textContent = `Overdue \u00b7 ${humanDate(task.due_date)}`;
        } else {
            if (!task.completed && task.due_date <= shiftIso(1)) {
                chip.classList.add("chip--today");
            }
            chip.textContent = `Due ${humanDate(task.due_date)}`;
        }
        chip.title = `Due ${task.due_date}`;
        li.appendChild(chip);
    }

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "item__edit";
    edit.textContent = "\u270e";
    edit.title = "Edit task";
    edit.setAttribute("aria-label", `Edit: ${task.title}`);
    edit.addEventListener("click", () => {
        editingId = task.id;
        render();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "item__delete";
    del.innerHTML = "&times;";
    del.setAttribute("aria-label", `Delete: ${task.title}`);
    del.addEventListener("click", () => remove(task));

    li.append(edit, del);
    return li;
}

function createEditor(task) {
    const li = document.createElement("li");
    li.className = "item item--editing";

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
    save.addEventListener("click", () =>
        saveEdit(task, {
            title: title.value,
            priority: priority.value,
            due_date: due.value,
        })
    );

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
        }
        day.setAttribute(
            "aria-label",
            due.length > 0 ? `${stamp}: ${due.length} task(s) due` : stamp
        );
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

function selectDate(stamp) {
    selectedDate = selectedDate === stamp ? null : stamp;
    editingId = null;
    render();
}

function stepMonth(delta) {
    const moved = new Date(view.year, view.month + delta, 1);
    view.year = moved.getFullYear();
    view.month = moved.getMonth();
    renderCalendar();
}

async function add(payload) {
    await api("/tasks", { method: "POST", body: JSON.stringify(payload) });
}

async function toggle(task) {
    await api(`/tasks/${task.id}/toggle`, { method: "POST" });
}

async function remove(task) {
    if (editingId === task.id) editingId = null;
    await api(`/tasks/${task.id}`, { method: "DELETE" });
}

async function saveEdit(task, changes) {
    const title = changes.title.trim();
    if (!title) {
        showError("Task title cannot be empty.");
        return;
    }
    clearError();
    try {
        await api(`/tasks/${task.id}`, {
            method: "PATCH",
            body: JSON.stringify({
                title,
                priority: changes.priority,
                due_date: changes.due_date,
            }),
        });
    } catch (err) {
        showError(err.message);
        return;
    }
    editingId = null;
    render();
}

async function refresh() {
    try {
        await api("/tasks");
    } catch (err) {
        showError(err.message);
    }
}

form.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) {
        showError("Type something first.");
        input.focus();
        return;
    }
    clearError();
    input.value = "";
    add({ title, priority: priorityEl.value, due_date: dueEl.value })
        .catch((err) => showError(err.message));
});

input.addEventListener("input", clearError);

prevBtn.addEventListener("click", () => stepMonth(-1));
nextBtn.addEventListener("click", () => stepMonth(1));
clearBtn.addEventListener("click", () => selectDate(selectedDate));

render();      // paint the cached snapshot straight away
refresh();     // then reconcile with SQLite
