const state = {
  profile: null,
  materials: [],
  teacher: {},
  history: [],
  language: localStorage.getItem("sh_lang") || "en",
  subjects: [],
  lesson: null,
  runId: 0,
  hold: false,
  pause: false,
  skip: false,
  guest: false,
  exercise: null,
  recog: null,
  quota: null,
  planning: false,
  planNote: "",
  starting: false,
  lessonActive: false,
  beatTimer: null,
  uploading: false,
};

const MAX_PART = 1_000_000; // bytes per uploaded part (the server allows 1 MB)
const TEXT_CHUNK = 55_000; // characters per text part (the server reads 60,000)

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const SAMPLE_LESSON = {
  subject: "Mathematics",
  topic: "Angles on a straight line",
  layout: "single",
  language: "en",
  segments: [
    {
      kind: "title",
      section: 1,
      speech: "Today we stay with one idea. Angles on a straight line add up to one hundred and eighty degrees.",
      elements: [
        { type: "title", text: "Angles on a straight line" },
        { type: "text", text: "A straight line is a half turn. Half of 360 is 180." },
      ],
    },
    {
      kind: "point",
      section: 1,
      speech: "Look at the protractor. The straight edge sits on the line, and the arc shows the half turn.",
      elements: [
        { type: "draw", shape: "protractor", nodes: [{ label: "180°" }] },
        { type: "text", text: "Put the baseline of the protractor on the straight line." },
      ],
    },
    {
      kind: "point",
      section: 2,
      speech: "If one angle is seventy degrees, the other is one hundred and ten.",
      elements: [
        { type: "draw", shape: "ruler", nodes: [{ label: "70°" }, { label: "110°" }] },
        { type: "text", text: "Adjacent angles on that line are supplementary." },
      ],
    },
    {
      kind: "point",
      section: 2,
      speech: "You can also see it as a circle cut in half. The full circle is 360 degrees.",
      elements: [{ type: "draw", shape: "circle", nodes: [{ label: "360°" }] }],
    },
    {
      kind: "point",
      section: 3,
      speech: "Use this cycle on every straight-line question.",
      elements: [{
        type: "draw",
        shape: "cycle",
        nodes: [{ label: "Find the line" }, { label: "Read one angle" }, { label: "Subtract from 180" }, { label: "Check" }],
      }],
    },
    {
      kind: "point",
      section: 4,
      speech: "Straight-line angles and triangle angles both total 180, but they are different reasons.",
      elements: [
        { type: "draw", shape: "venn", nodes: [{ label: "On a line" }, { label: "In a triangle" }, { label: "Both 180" }] },
        { type: "text", text: "Same total. Different picture. Do not mix the reasons." },
      ],
    },
  ],
};

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  $("#toast-root").append(node);
  setTimeout(() => node.remove(), 4600);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;")
    .replace(/'/g, "\u0026#39;");
}

function markdown(text) {
  const source = String(text || "");
  try {
    const raw = window.marked ? marked.parse(source, { breaks: true, gfm: true }) : `<p>${escapeHtml(source)}</p>`;
    const tpl = document.createElement("template");
    tpl.innerHTML = String(raw);
    tpl.content.querySelectorAll("script,iframe,object,embed,link,style").forEach((node) => node.remove());
    tpl.content.querySelectorAll("*").forEach((node) => {
      [...node.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || name === "srcdoc") node.removeAttribute(attr.name);
        if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
      });
    });
    return tpl.innerHTML;
  } catch {
    return `<p>${escapeHtml(source)}</p>`;
  }
}

async function api(path, { method = "GET", json, form, auth = true } = {}) {
  const headers = {};
  const token = localStorage.getItem("sh_token") || "";
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) body = form;
  else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(path, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth) {
    localStorage.removeItem("sh_token");
    showScreen("auth");
  }
  if (data.quota) setQuota(data.quota);
  if (!res.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = res.status;
    error.data = data;
    if (data.code === "user_quota" && state.quota) setQuota({ ...state.quota, remaining: 0, used: state.quota.limit });
    throw error;
  }
  return data;
}

function showScreen(name) {
  $("#screen-auth").hidden = name !== "auth";
  $("#screen-profile").hidden = name !== "profile";
  $("#screen-app").hidden = name !== "app";
}

function profileComplete(profile) {
  return Boolean(profile && profile.name && profile.grade && profile.level && profile.examBoard && profile.age && profile.subjects?.length);
}

function setLanguage(lang) {
  state.language = lang === "ny" ? "ny" : "en";
  localStorage.setItem("sh_lang", state.language);
  $$("[data-lang]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.lang === state.language)));
  const note = $("#class-lang-note");
  if (note) {
    note.textContent = state.language === "ny"
      ? "Your teacher will teach in Chichewa. Speech uses a Chichewa voice when the device has one."
      : "Your teacher will teach in English. Switch to Chichewa at the top if you prefer.";
  }
}

function showView(name) {
  if (name !== "class" && state.lessonActive) leaveClass();
  $$("[data-view]").forEach((view) => { view.hidden = view.dataset.view !== name; });
  $$("[data-nav]").forEach((button) => button.setAttribute("aria-current", button.dataset.nav === name ? "page" : "false"));
  if (name === "today") renderToday();
  if (name === "timetable") renderTimetable();
  if (name === "vision") renderVision();
  if (name === "exercises") renderExerciseView();
  if (name === "class") renderClassSetup();
}

function busy(button, on, label) {
  if (!button) return;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label || "Working…";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

/* ---------- daily teacher-request meter ---------- */

function setQuota(quota) {
  state.quota = { ...(state.quota || {}), ...quota };
  renderQuota();
}

function untilText(resetAt) {
  const ms = (resetAt || 0) - Date.now();
  if (ms <= 0) return "soon";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.round((ms % 3600000) / 60000);
  return hours > 0 ? `${hours} h ${minutes} min` : `${Math.max(1, minutes)} min`;
}

function renderQuota() {
  const pill = $("#quota-pill");
  const q = state.quota;
  if (!q || q.limit === undefined || state.guest) {
    pill.hidden = true;
    return;
  }
  const remaining = Math.max(0, q.limit - q.used);
  pill.hidden = false;
  pill.textContent = `${remaining} left today`;
  pill.dataset.low = String(remaining <= Math.max(2, Math.round(q.limit * 0.15)));
  const fill = $("#meter-fill");
  if (fill) fill.style.width = `${Math.min(100, Math.round((q.used / Math.max(1, q.limit)) * 100))}%`;
  const text = $("#meter-text");
  if (text) text.textContent = `${q.used} of ${q.limit} used today · refreshes in ${untilText(q.resetAt)} (midnight, Malawi time)`;
}

/* ---------- profile ---------- */

function renderSubjects() {
  const host = $("#subject-chips");
  host.innerHTML = "";
  state.subjects.forEach((subject, index) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.append(document.createTextNode(subject));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${subject}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.subjects.splice(index, 1);
      renderSubjects();
    });
    chip.append(remove);
    host.append(chip);
  });
}

const BOARD_OPTIONS = ["MANEB", "Cambridge International", "Edexcel", "IB", "TEVET Malawi", "University or college exams"];

function updateLevelUI() {
  const form = $("#form-profile");
  const level = form.level.value;
  const college = level === "college";
  $("#institution-wrap").hidden = !college;
  $("#course-wrap").hidden = !college;
  $("#grade-label").firstChild.textContent = college ? "Year / semester" : "Class / form";
  form.grade.placeholder = college ? "Year 2, Semester 1" : "Form 3";
  $("#subjects-legend").textContent = college ? "Courses / modules" : "Subjects";
  $("#subject-input").placeholder = college ? "Add a course, then press Add" : "Add a subject, then press Add";
  if (!form.boardChoice.value) {
    if (college) form.boardChoice.value = "University or college exams";
    else if (level === "junior-secondary" || level === "senior-secondary" || level === "primary") form.boardChoice.value = "MANEB";
  }
  updateBoardUI();
}

function updateBoardUI() {
  const form = $("#form-profile");
  const other = form.boardChoice.value === "__other";
  $("#board-other-wrap").hidden = !other;
  form.boardOther.required = other;
}

function fillProfileForm() {
  const form = $("#form-profile");
  const profile = state.profile || {};
  form.name.value = profile.name || "";
  form.age.value = profile.age || "";
  form.level.value = profile.level || "";
  form.grade.value = profile.grade || "";
  form.institution.value = profile.institution || "";
  form.course.value = profile.course || "";
  form.examDate.value = profile.examDate || "";
  form.studyHours.value = profile.studyHours || 2;
  if (!profile.examBoard) form.boardChoice.value = "";
  else if (BOARD_OPTIONS.includes(profile.examBoard)) form.boardChoice.value = profile.examBoard;
  else {
    form.boardChoice.value = "__other";
    form.boardOther.value = profile.examBoard;
  }
  state.subjects = [...(profile.subjects || [])];
  renderSubjects();
  updateLevelUI();
}

function enterApp() {
  state.guest = false;
  $("#guest-note").hidden = true;
  $("#sign-out").textContent = "Sign out";
  showScreen("app");
  if (!$("#thread").childElementCount) {
    addMessage("assistant", "Ask me about anything in your notes. I answer only from what you uploaded, and I will point you to the next step.");
  }
  renderMaterials();
  renderQuota();
  showView("today");
  ensurePlan();
}

function addMessage(role, text) {
  const item = document.createElement("article");
  item.className = `bubble ${role}`;
  if (role === "assistant") {
    const body = document.createElement("div");
    body.className = "prose";
    body.innerHTML = markdown(text);
    item.append(body);
  } else item.textContent = text;
  $("#thread").append(item);
  $("#thread").scrollTop = $("#thread").scrollHeight;
}

function renderMaterials() {
  const list = $("#material-list");
  list.innerHTML = "";
  if (!state.materials.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No notes yet. Upload a PDF, DOCX or photo and your teacher will read it.";
    list.append(empty);
    return;
  }
  state.materials.forEach((material) => {
    const item = document.createElement("li");
    item.className = "material";
    const title = document.createElement("h3");
    title.textContent = material.name;
    const meta = document.createElement("p");
    const parts = material.parts > 1 ? ` · ${material.partsDone || material.parts} of ${material.parts} parts` : "";
    meta.textContent = `${material.subject}${parts}`;
    const topics = document.createElement("p");
    topics.className = "subtopics";
    topics.textContent = (material.topics || []).map((topic) => topic.name).join(" · ");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn ghost";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      try {
        await api("/api/materials", { method: "DELETE", json: { id: material.id } });
        state.materials = state.materials.filter((row) => row.id !== material.id);
        renderMaterials();
        renderToday();
      } catch (err) { toast(err.message); }
    });
    item.append(title, meta, topics, remove);
    list.append(item);
  });
}

/* ---------- the teacher decides: Today, plan, timetable ---------- */

async function ensurePlan(force = false) {
  if (state.guest || state.planning || !state.materials.length) return;
  if (!force && !state.teacher?.planStale) return;
  state.planning = true;
  state.planNote = "";
  renderToday();
  try {
    const data = await api("/api/teacher/plan", { method: "POST", json: { language: state.language } });
    state.teacher = data.teacher;
  } catch (err) {
    state.planNote = err.message;
  } finally {
    state.planning = false;
    renderToday();
    if (!$("#view-timetable").hidden) renderTimetable();
    if (!$("#view-vision").hidden) renderVision();
  }
}

const ACTIVITY_LABEL = { class: "Class", exercise: "Practice", revision: "Revision", reading: "Reading" };

function todayName() {
  return new Date().toLocaleDateString("en-US", { weekday: "long" });
}

function renderToday() {
  if ($("#view-today").hidden && !state.profile) return;
  const t = state.teacher || {};
  const hasNotes = state.materials.length > 0;
  const first = (state.profile?.name || state.profile?.username || "").split(" ")[0];
  const title = $("#today-title");
  const reason = $("#today-reason");
  const go = $("#today-go");
  const notesBtn = $("#today-notes");
  const note = $("#today-note");
  go.hidden = false;
  go.disabled = false;
  notesBtn.hidden = true;
  note.textContent = "";
  const pending = (t.exercises || []).find((e) => !e.graded);
  if (!hasNotes) {
    title.textContent = first ? `Let's begin, ${first}` : "Let's begin";
    reason.textContent = "Upload your notes — PDFs, Word files or photos. I read them, plan your week, and start teaching. I teach only from what you give me.";
    go.hidden = true;
    notesBtn.hidden = false;
  } else if (state.planning) {
    title.textContent = "Your teacher is planning…";
    reason.textContent = "Reading your notes and working out what you should do first.";
    go.disabled = true;
    go.textContent = "One moment";
  } else if (pending) {
    title.textContent = `Practice waiting: ${pending.topic}`;
    reason.textContent = "Your teacher set this exercise for you. Finish it so she can see how the topic went.";
    go.textContent = "Open the exercise";
    go.dataset.action = "exercise-open";
  } else if (t.next?.topic) {
    const label = { class: "Next class", exercise: "Practice", revise: "Revision" }[t.next.action] || "Next";
    title.textContent = `${label}: ${t.next.topic}`;
    reason.textContent = t.next.reason || "";
    go.textContent = t.next.action === "exercise" ? "Get my practice" : t.next.action === "revise" ? "Start revision class" : "Start class";
    go.dataset.action = t.next.action === "exercise" ? "exercise-new" : "class";
  } else {
    title.textContent = first ? `Ready when you are, ${first}` : "Ready when you are";
    reason.textContent = "Your teacher will choose the first topic from your notes.";
    go.textContent = "Start class";
    go.dataset.action = "class";
  }
  if (state.planNote) note.textContent = state.planNote;
  const health = state.quota?.health;
  const banner = $("#today-health");
  banner.hidden = !health?.message;
  banner.textContent = health?.message || "";
  $("#today-day").textContent = todayName();
  const blocks = $("#today-blocks");
  blocks.innerHTML = "";
  const day = (t.timetable?.days || []).find((d) => String(d.day).toLowerCase() === todayName().toLowerCase());
  if (!day?.blocks?.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = t.timetable?.days?.length ? "A lighter day — rest, or revise what you have learned." : "Your teacher will fill this in after she plans your week.";
    blocks.append(p);
  } else {
    day.blocks.forEach((block) => blocks.append(blockNode(block)));
  }
  const list = $("#today-announce");
  list.innerHTML = "";
  const items = t.announcements || [];
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Nothing yet.";
    list.append(li);
  }
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item.text || item;
    list.append(li);
  });
  renderQuota();
}

function blockNode(block) {
  const node = document.createElement("div");
  node.className = `block act-${block.activity || "reading"}`;
  const when = document.createElement("strong");
  when.textContent = [block.start, block.end].filter(Boolean).join("–");
  const tag = document.createElement("em");
  tag.textContent = ACTIVITY_LABEL[block.activity] || "";
  const task = document.createElement("span");
  task.textContent = `${block.subject ? block.subject + ": " : ""}${block.task}`;
  node.append(when, tag, task);
  return node;
}

function renderTimetable() {
  const grid = $("#week-grid");
  const summary = $("#week-summary");
  const timetable = state.teacher?.timetable;
  grid.innerHTML = "";
  if (!timetable?.days?.length) {
    summary.textContent = state.materials.length
      ? (state.planning ? "Your teacher is planning your week…" : "Your teacher will plan your week automatically.")
      : "Upload your notes first. Your teacher plans the week from them.";
    return;
  }
  const when = state.teacher.planUpdatedAt ? ` Updated ${new Date(state.teacher.planUpdatedAt).toLocaleDateString()}. It changes by itself after each class and exercise.` : "";
  summary.textContent = (timetable.summary || "") + when;
  const today = todayName().toLowerCase();
  timetable.days.forEach((day) => {
    const card = document.createElement("article");
    card.className = "day";
    if (String(day.day).toLowerCase() === today) card.classList.add("is-today");
    const title = document.createElement("h3");
    title.textContent = day.day;
    card.append(title);
    if (!day.blocks?.length) {
      const rest = document.createElement("p");
      rest.className = "muted";
      rest.textContent = "Lighter day";
      card.append(rest);
    }
    (day.blocks || []).forEach((block) => card.append(blockNode(block)));
    grid.append(card);
  });
}

function daysUntil(date) {
  if (!date) return null;
  const target = new Date(`${date}T00:00:00`);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - start) / 86400000);
}

function renderVision() {
  const profile = state.profile;
  const left = daysUntil(profile?.examDate);
  const count = $("#countdown");
  const label = $("#countdown-label");
  if (left === null) {
    count.textContent = "—";
    label.textContent = "No exam date set. Add one on your profile and your teacher will plan around it.";
  } else if (left > 1) {
    count.textContent = String(left);
    label.textContent = `days until ${profile.examDate}`;
  } else if (left === 1) {
    count.textContent = "1";
    label.textContent = "day until the exam";
  } else if (left === 0) {
    count.textContent = "Today";
    label.textContent = "Exam day";
  } else {
    count.textContent = "Past";
    label.textContent = "That exam date has passed. Update it if there is another paper.";
  }
  const vision = state.teacher?.vision;
  const copy = $("#vision-copy");
  copy.className = "prose";
  copy.innerHTML = markdown(vision?.statement || "Your teacher writes this after she has planned your weeks.");
  const announcements = $("#announce-list");
  announcements.innerHTML = "";
  (state.teacher?.announcements || []).forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item.text || item;
    announcements.append(li);
  });
  const learned = $("#learned-list");
  learned.innerHTML = "";
  const topics = state.teacher?.learnedTopics || [];
  if (!topics.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Finish a live class and the topic lands here.";
    learned.append(li);
  }
  topics.forEach((topic) => {
    const li = document.createElement("li");
    li.textContent = topic;
    learned.append(li);
  });
  const results = $("#results-list");
  results.innerHTML = "";
  const rows = state.teacher?.results || [];
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No graded exercises yet.";
    results.append(li);
  }
  rows.slice().reverse().forEach((row) => {
    const li = document.createElement("li");
    li.textContent = `${row.topic}: ${row.score} / ${row.max}`;
    results.append(li);
  });
}

/* ---------- exercises ---------- */

function renderExerciseView() {
  const list = state.teacher?.exercises || [];
  const pending = list.slice().reverse().find((e) => !e.graded);
  if (pending && (!state.exercise || state.exercise.graded)) {
    state.exercise = pending;
    renderQuestions(pending);
  }
  const meta = $("#exercise-meta");
  if (state.exercise && !state.exercise.graded) {
    meta.textContent = `${state.exercise.subject}: ${state.exercise.topic} · ${state.exercise.difficulty || "medium"} · ${state.exercise.questions.length} questions`;
  } else meta.textContent = "";
  $("#form-exercise button").textContent = state.exercise && !state.exercise.graded ? "Give me different practice" : "Give me practice";
}

async function requestExercise(topicHint) {
  const data = await api("/api/exercises/generate", {
    method: "POST",
    json: { language: state.language, topic: topicHint || "" },
  });
  state.exercise = data.exercise;
  state.teacher.exercises = [...(state.teacher.exercises || []), data.exercise].slice(-8);
  renderQuestions(data.exercise);
  return data.exercise;
}

function renderQuestions(exercise) {
  const list = $("#question-list");
  list.innerHTML = "";
  $("#exercise-title").textContent = exercise.title;
  exercise.questions.forEach((question, index) => {
    const card = document.createElement("fieldset");
    card.className = "question";
    const legend = document.createElement("legend");
    legend.textContent = `${index + 1}. ${question.type === "essay" ? "Essay" : "Multiple choice"}`;
    const prompt = document.createElement("p");
    prompt.textContent = question.prompt;
    card.append(legend, prompt);
    if (question.type === "mcq") {
      question.choices.forEach((choice) => {
        const label = document.createElement("label");
        label.className = "choice";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = question.id;
        input.value = choice;
        label.append(input, document.createTextNode(choice));
        card.append(label);
      });
    } else {
      const area = document.createElement("textarea");
      area.name = question.id;
      area.rows = 4;
      area.placeholder = "Write your answer";
      card.append(area);
    }
    list.append(card);
  });
  $("#form-answers").hidden = false;
  $("#grade-card").hidden = true;
}

function collectAnswers() {
  return state.exercise.questions.map((question) => {
    if (question.type === "mcq") {
      const picked = document.querySelector(`input[name="${CSS.escape(question.id)}"]:checked`);
      return { id: question.id, text: picked ? picked.value : "" };
    }
    const area = document.querySelector(`textarea[name="${CSS.escape(question.id)}"]`);
    return { id: question.id, text: area ? area.value.trim() : "" };
  });
}

function renderGrade(grade) {
  $("#grade-card").hidden = false;
  $("#grade-score").textContent = `${grade.score} / ${grade.maxScore}`;
  const body = $("#grade-body");
  const lines = [`<p>${escapeHtml(grade.summary || "")}</p>`];
  (grade.questions || []).forEach((question) => {
    lines.push(`<p class="grade-line"><strong>${escapeHtml(question.id)}</strong> · ${escapeHtml(String(question.score))} / ${escapeHtml(String(question.max))}<br>${escapeHtml(question.feedback || "")}</p>`);
  });
  body.innerHTML = lines.join("");
}

/* ---------- uploads: split anything bigger than 1 MB ---------- */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = src;
    tag.onload = resolve;
    tag.onerror = () => reject(new Error("Could not load the PDF splitter. Check your connection and try again."));
    document.head.append(tag);
  });
}

function baseName(name) {
  return String(name || "notes").replace(/\.[^.]+$/, "");
}

/** Halves the page range again and again until every part is <= 1 MB. */
async function splitPdf(file) {
  if (!window.PDFLib) await loadScript("/vendor/pdf-lib.min.js");
  const { PDFDocument } = window.PDFLib;
  let src;
  try {
    src = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
  } catch {
    throw new Error("That PDF could not be opened for splitting. Try exporting it again.");
  }
  const parts = [];
  async function build(from, to) {
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(src, Array.from({ length: to - from }, (_, i) => from + i));
    pages.forEach((page) => doc.addPage(page));
    return doc.save({ useObjectStreams: true });
  }
  async function walk(from, to) {
    const bytes = await build(from, to);
    if (bytes.length <= MAX_PART) {
      parts.push({ from, bytes });
      return;
    }
    if (to - from <= 1) {
      throw new Error(`Page ${from + 1} alone is bigger than 1 MB. Export the PDF at a lower quality and try again.`);
    }
    const mid = from + Math.ceil((to - from) / 2);
    await walk(from, mid);
    await walk(mid, to);
  }
  await walk(0, src.getPageCount());
  parts.sort((a, b) => a.from - b.from);
  const stem = baseName(file.name);
  return parts.map((part, index) => ({
    blob: new Blob([part.bytes], { type: "application/pdf" }),
    name: `${stem}-part${index + 1}.pdf`,
  }));
}

async function splitText(file) {
  const text = await file.text();
  const parts = [];
  for (let at = 0; at < text.length; at += TEXT_CHUNK) {
    let end = Math.min(text.length, at + TEXT_CHUNK);
    if (end < text.length) {
      const cut = text.lastIndexOf("\n", end);
      if (cut > at + TEXT_CHUNK * 0.6) end = cut;
    }
    parts.push(text.slice(at, end));
    at = end - TEXT_CHUNK;
  }
  const stem = baseName(file.name);
  return parts.map((chunk, index) => ({ blob: new Blob([chunk], { type: "text/plain" }), name: `${stem}-part${index + 1}.txt` }));
}

async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  let scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", Math.max(0.45, 0.82 - attempt * 0.06)));
    if (blob && blob.size <= MAX_PART) return { blob, name: `${baseName(file.name)}.jpg` };
    scale *= 0.8;
  }
  throw new Error("That photo is too large even after shrinking. Take it again from a bit further away.");
}

async function prepareUpload(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".md") || file.type.startsWith("text/")) return splitText(file);
  if (file.size <= MAX_PART) return [{ blob: file, name: file.name }];
  if (lower.endsWith(".pdf") || file.type === "application/pdf") return splitPdf(file);
  if (file.type.startsWith("image/")) return [await shrinkImage(file)];
  throw new Error("Word files over 1 MB cannot be split. Save it as a PDF — big PDFs are split for you.");
}

async function uploadNotes(file, statusNode) {
  const pieces = await prepareUpload(file);
  const groupId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  let saved = 0;
  try {
    for (let i = 0; i < pieces.length; i += 1) {
      statusNode.textContent = pieces.length > 1
        ? `Large file split into ${pieces.length} parts. Reading part ${i + 1} of ${pieces.length}…`
        : "Reading your notes…";
      const form = new FormData();
      form.append("file", pieces[i].blob, pieces[i].name);
      form.append("groupId", groupId);
      form.append("displayName", file.name);
      form.append("part", String(i + 1));
      form.append("parts", String(pieces.length));
      const data = await api("/api/materials/upload", { method: "POST", form });
      saved += 1;
      const at = state.materials.findIndex((row) => row.id === data.material.id);
      if (at >= 0) state.materials[at] = data.material;
      else state.materials.push(data.material);
      renderMaterials();
    }
  } catch (err) {
    if (saved) err.message = `${err.message} (Saved ${saved} of ${pieces.length} parts — add the rest later.)`;
    throw err;
  } finally {
    if (saved) {
      state.teacher.planStale = true;
      renderToday();
    }
  }
  statusNode.textContent = "";
  return pieces.length;
}

function svgEl(name, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

function chalkLabel(x, y, text, size = 22) {
  const node = svgEl("text", { x, y, "text-anchor": "middle", fill: "#f4f0e2", "font-size": size });
  node.textContent = text;
  return node;
}

function strokeDraw(el) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const len = typeof el.getTotalLength === "function" ? el.getTotalLength() : 300;
  if (reduce || !Number.isFinite(len)) return Promise.resolve();
  el.style.strokeDasharray = `${len}`;
  el.style.strokeDashoffset = `${len}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };
    el.addEventListener("transitionend", finish, { once: true });
    requestAnimationFrame(() => {
      el.style.transition = "stroke-dashoffset 1.25s ease";
      el.style.strokeDashoffset = "0";
    });
    setTimeout(finish, 1400);
  });
}

function drawShape(shape, nodes) {
  const labels = (nodes || []).map((node) => node.label).filter(Boolean);
  const svg = svgEl("svg", { viewBox: "0 0 360 220", class: "chalk-draw", role: "img" });
  const strokes = [];
  const add = (el) => {
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "#f4f0e2");
    el.setAttribute("stroke-width", "3");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    svg.append(el);
    strokes.push(el);
  };
  if (shape === "circle") {
    add(svgEl("circle", { cx: 180, cy: 108, r: 70 }));
    svg.append(chalkLabel(180, 114, labels[0] || "circle", 28));
  } else if (shape === "cycle") {
    add(svgEl("circle", { cx: 180, cy: 110, r: 78 }));
    const steps = labels.length ? labels : ["1", "2", "3"];
    steps.forEach((label, index) => {
      const angle = (-Math.PI / 2) + (index / steps.length) * Math.PI * 2;
      const x = 180 + Math.cos(angle) * 78;
      const y = 110 + Math.sin(angle) * 78;
      add(svgEl("circle", { cx: x, cy: y, r: 8 }));
      svg.append(chalkLabel(180 + Math.cos(angle) * 112, 110 + Math.sin(angle) * 96, label, 18));
    });
  } else if (shape === "venn") {
    const three = labels.length >= 3;
    add(svgEl("circle", { cx: three ? 150 : 145, cy: three ? 100 : 110, r: 62 }));
    add(svgEl("circle", { cx: three ? 214 : 215, cy: three ? 100 : 110, r: 62 }));
    if (three) add(svgEl("circle", { cx: 182, cy: 150, r: 62 }));
    svg.append(chalkLabel(118, 78, labels[0] || "A", 18));
    svg.append(chalkLabel(246, 78, labels[1] || "B", 18));
    if (three) svg.append(chalkLabel(182, 196, labels[2], 18));
    else svg.append(chalkLabel(180, 114, "both", 18));
  } else if (shape === "ruler") {
    add(svgEl("line", { x1: 28, y1: 120, x2: 332, y2: 120 }));
    for (let i = 0; i <= 10; i += 1) {
      const x = 28 + i * 30.4;
      add(svgEl("line", { x1: x, y1: 120, x2: x, y2: i % 5 === 0 ? 96 : 106 }));
    }
    svg.append(chalkLabel(90, 78, labels[0] || "0", 26));
    svg.append(chalkLabel(270, 78, labels[1] || labels[0] || "10", 26));
  } else if (shape === "protractor") {
    add(svgEl("path", { d: "M40 160 A140 140 0 0 1 320 160" }));
    add(svgEl("line", { x1: 40, y1: 160, x2: 320, y2: 160 }));
    for (let deg = 0; deg <= 180; deg += 15) {
      const rad = Math.PI - (deg * Math.PI) / 180;
      const inner = deg % 45 === 0 ? 118 : 128;
      const x1 = 180 + Math.cos(rad) * 140;
      const y1 = 160 - Math.sin(rad) * 140;
      const x2 = 180 + Math.cos(rad) * inner;
      const y2 = 160 - Math.sin(rad) * inner;
      add(svgEl("line", { x1, y1, x2, y2 }));
    }
    svg.append(chalkLabel(180, 108, labels[0] || "180°", 28));
  } else {
    add(svgEl("circle", { cx: 180, cy: 110, r: 60 }));
  }
  return { svg, strokes };
}

async function typeText(node, text, run) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || state.skip || run !== state.runId) {
    node.textContent = text;
    return;
  }
  node.textContent = "";
  const limit = Math.min(text.length, 320);
  for (let i = 1; i <= limit; i += 1) {
    if (state.skip || run !== state.runId) {
      node.textContent = text;
      return;
    }
    node.textContent = text.slice(0, i);
    await sleep(text.length > 180 ? 8 : 16);
  }
  node.textContent = text;
}

async function renderSegment(lesson, segment, run) {
  const stage = $("#board-stage");
  stage.innerHTML = "";
  stage.dataset.layout = lesson.layout || "single";
  const jobs = [];
  segment.elements.forEach((element) => {
    if (element.type === "draw") {
      const drawn = drawShape(element.shape, element.nodes);
      stage.append(drawn.svg);
      jobs.push(Promise.all(drawn.strokes.map((stroke) => strokeDraw(stroke))));
      return;
    }
    const node = document.createElement(element.type === "title" ? "h3" : "div");
    node.className = element.type === "title" ? "chalk-title" : "chalk-text";
    stage.append(node);
    if (element.type === "title") jobs.push(typeText(node, element.text, run));
    else {
      jobs.push(typeText(node, element.text.replace(/[#*_`]/g, ""), run).then(() => {
        if (window.marked) node.innerHTML = markdown(element.text);
      }));
    }
  });
  await Promise.all(jobs);
}

function unlockSpeech() {
  if (!window.speechSynthesis) return;
  const primer = new SpeechSynthesisUtterance(" ");
  primer.volume = 0;
  primer.rate = 0.65;
  window.speechSynthesis.speak(primer);
}

function speak(text, lang, run) {
  return new Promise((resolve) => {
    if (!text || !window.speechSynthesis || run !== state.runId || state.hold || state.skip) {
      resolve();
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.65;
    utter.lang = lang === "ny" ? "ny-MW" : "en-US";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(watchdog);
      resolve();
    };
    utter.onend = finish;
    utter.onerror = finish;
    const poll = setInterval(() => {
      if (run !== state.runId || state.skip || state.hold) {
        window.speechSynthesis.cancel();
        finish();
      }
    }, 120);
    const watchdog = setTimeout(() => {
      window.speechSynthesis.cancel();
      finish();
    }, Math.min(90000, 2500 + text.split(/\s+/).length * 480));
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  });
}

async function gate(run) {
  while ((state.hold || state.pause) && run === state.runId && !state.skip) await sleep(80);
}

async function playLesson(lesson) {
  const run = ++state.runId;
  state.hold = false;
  state.pause = false;
  state.skip = false;
  state.lessonActive = true;
  $("#class-pause").textContent = "Pause";
  $("#class-setup").hidden = true;
  $("#class-room").hidden = false;
  $("#class-subject").textContent = lesson.subject;
  $("#class-topic").textContent = lesson.topic;
  $("#hand-panel").hidden = true;
  for (let index = 0; index < lesson.segments.length; index += 1) {
    if (run !== state.runId) return;
    state.skip = false;
    $("#class-progress").textContent = `${index + 1} / ${lesson.segments.length}`;
    await gate(run);
    if (run !== state.runId) return;
    await renderSegment(lesson, lesson.segments[index], run);
    if (run !== state.runId) return;
    if (!state.skip) await speak(lesson.segments[index].speech, lesson.language, run);
    if (!state.skip && run === state.runId) await dwell(1700, run);
    await gate(run);
  }
  if (run !== state.runId) return;
  $("#class-progress").textContent = "End of class";
  finishLesson(lesson);
}

/** Marks the topic as taught, frees the class seat, and lets the teacher decide about practice. */
async function finishLesson(lesson) {
  state.lessonActive = false;
  stopBeat();
  if (state.guest) return;
  try {
    await api("/api/classroom/complete", { method: "POST", json: { subject: lesson.subject, topic: lesson.topic } });
    const label = `${lesson.subject}: ${lesson.topic}`;
    const learned = new Set(state.teacher.learnedTopics || []);
    learned.add(label);
    state.teacher.learnedTopics = [...learned];
    state.teacher.planStale = true;
  } catch { /* the class still happened */ }
  toast("Class finished. That topic is marked as learned.");
  if (lesson.followUp?.exercise !== false) {
    try {
      toast("Your teacher is setting you an exercise…");
      const exercise = await requestExercise(lesson.topic);
      toast(`Exercise ready: ${exercise.title}. Find it under Exercises.`);
    } catch (err) {
      toast(err.message);
    }
  }
  renderToday();
}
function dwell(ms, run) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (run !== state.runId || state.skip || state.hold || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 60);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recentBoardText() {
  return $("#board-stage")?.innerText?.slice(0, 1500) || "";
}

function stopLesson() {
  state.runId += 1;
  state.hold = false;
  state.pause = false;
  window.speechSynthesis?.cancel();
  state.recog?.abort?.();
}

function startBeat() {
  stopBeat();
  state.beatTimer = setInterval(() => {
    api("/api/classroom/heartbeat", { method: "POST" }).catch(() => {});
  }, 30000);
}

function stopBeat() {
  if (state.beatTimer) clearInterval(state.beatTimer);
  state.beatTimer = null;
}

/** Leaves the class early: stops the board and gives the seat to the next student. */
function leaveClass() {
  const wasActive = state.lessonActive;
  stopLesson();
  state.lessonActive = false;
  stopBeat();
  if (wasActive && !state.guest && localStorage.getItem("sh_token")) {
    api("/api/classroom/leave", { method: "POST" }).catch(() => {});
  }
}

function showQueue(data) {
  $("#class-queue").hidden = false;
  $("#class-start-row").hidden = true;
  $("#queue-text").textContent = data.message || "Class is full. Please wait for your turn.";
}

function hideQueue() {
  $("#class-queue").hidden = true;
  $("#class-start-row").hidden = false;
}

function renderClassSetup() {
  setLanguage(state.language);
  const next = state.teacher?.next;
  const plan = $("#class-plan");
  if (!state.materials.length) plan.textContent = "Upload your notes first — your teacher teaches only from them.";
  else if (next?.topic && next.action !== "exercise") plan.textContent = `Your teacher plans: ${next.topic}${next.reason ? " — " + next.reason : ""}`;
  else plan.textContent = "Your teacher will pick the topic from your notes.";
  if (!state.starting) hideQueue();
}

/** Asks the teacher to start. If every seat is taken, waits in line and starts by itself. */
async function beginClass() {
  if (state.starting) return;
  if (!state.materials.length) {
    toast("Upload your notes first. Your teacher teaches only from them.");
    showView("tutor");
    return;
  }
  state.starting = true;
  unlockSpeech();
  const button = $("#start-class");
  busy(button, true, "Setting the board…");
  try {
    while (state.starting) {
      const data = await api("/api/classroom/start", { method: "POST", json: { language: state.language } });
      if (data.queued) {
        showQueue(data);
        await sleep(7000);
        continue;
      }
      hideQueue();
      state.lesson = data.lesson;
      state.guest = false;
      showView("class");
      startBeat();
      state.starting = false;
      await playLesson(data.lesson);
      break;
    }
  } catch (err) {
    hideQueue();
    stopBeat();
    toast(err.message);
    if (err.data?.code === "no_notes") showView("tutor");
  } finally {
    state.starting = false;
    busy(button, false);
  }
}

async function boot() {
  if (window.marked?.setOptions) marked.setOptions({ breaks: true, gfm: true });
  setLanguage(state.language);
  let setup = null;
  try { setup = await api("/api/setup", { auth: false }); } catch { setup = null; }
  const banner = $("#setup-banner");
  const appBanner = $("#app-banner");
  const message = !setup
    ? "The app server is not answering."
    : setup.ok
      ? ""
      : "Add GEMINI_API_KEY (or add a key in the admin dashboard), GITHUB_TOKEN, GITHUB_OWNER, and AUTH_SECRET before accounts or lessons can be saved. The sample chalkboard still works.";
  banner.hidden = !message;
  appBanner.hidden = !message;
  banner.textContent = message;
  appBanner.textContent = message;
  const token = localStorage.getItem("sh_token");
  if (!token) {
    showScreen("auth");
    return;
  }
  try {
    await loadSession();
  } catch (err) {
    if (err.status !== 401) toast(err.message);
    showScreen("auth");
  }
}

async function loadSession() {
  const data = await api("/api/bootstrap");
  state.profile = data.profile;
  state.materials = data.materials || [];
  state.teacher = data.teacher || {};
  if (data.quota) setQuota(data.quota);
  if (!profileComplete(data.profile)) {
    fillProfileForm();
    showScreen("profile");
  } else enterApp();
}

$("#tab-login").addEventListener("click", () => {
  $("#tab-login").setAttribute("aria-selected", "true");
  $("#tab-register").setAttribute("aria-selected", "false");
  $("#form-login").hidden = false;
  $("#form-register").hidden = true;
});
$("#tab-register").addEventListener("click", () => {
  $("#tab-register").setAttribute("aria-selected", "true");
  $("#tab-login").setAttribute("aria-selected", "false");
  $("#form-register").hidden = false;
  $("#form-login").hidden = true;
});

$("#form-login").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  busy(button, true, "Checking…");
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      auth: false,
      json: { username: event.target.username.value, password: event.target.password.value },
    });
    localStorage.setItem("sh_token", data.token);
    await loadSession();
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

$("#form-register").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.password.value !== form.confirm.value) {
    toast("Those passwords do not match.");
    return;
  }
  const button = form.querySelector("button");
  busy(button, true, "Creating…");
  try {
    const data = await api("/api/auth/register", {
      method: "POST",
      auth: false,
      json: { username: form.username.value, password: form.password.value },
    });
    localStorage.setItem("sh_token", data.token);
    state.profile = data.profile;
    state.materials = [];
    state.teacher = { announcements: [], learnedTopics: [], planStale: true };
    fillProfileForm();
    showScreen("profile");
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

$("#subject-add").addEventListener("click", () => {
  const input = $("#subject-input");
  const value = input.value.trim();
  if (!value) return;
  if (!state.subjects.includes(value)) state.subjects.push(value);
  input.value = "";
  renderSubjects();
});
$("#subject-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("#subject-add").click();
  }
});
$("#profile-level").addEventListener("change", updateLevelUI);
$("#profile-board").addEventListener("change", updateBoardUI);

$("#form-profile").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.subjects.length) {
    toast(`Add at least one ${event.target.level.value === "college" ? "course" : "subject"}.`);
    return;
  }
  const form = event.target;
  const board = form.boardChoice.value === "__other" ? form.boardOther.value.trim() : form.boardChoice.value;
  const college = form.level.value === "college";
  const button = form.querySelector("button[type=submit]");
  busy(button, true, "Saving…");
  try {
    const data = await api("/api/profile", {
      method: "PUT",
      json: {
        name: form.name.value,
        age: Number(form.age.value),
        level: form.level.value,
        grade: form.grade.value,
        examBoard: board,
        institution: college ? form.institution.value : "",
        course: college ? form.course.value : "",
        examDate: form.examDate.value,
        studyHours: Number(form.studyHours.value),
        subjects: state.subjects,
      },
    });
    state.profile = data.profile;
    if (state.teacher) state.teacher.planStale = true;
    try {
      const bootData = await api("/api/bootstrap");
      state.materials = bootData.materials || [];
      state.teacher = bootData.teacher || {};
      if (bootData.quota) setQuota(bootData.quota);
    } catch { /* the app still opens */ }
    enterApp();
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

$("#profile-cancel").addEventListener("click", () => {
  if (profileComplete(state.profile)) enterApp();
  else showScreen("auth");
});

$("#sign-out").addEventListener("click", () => {
  if (state.guest) {
    leaveClass();
    state.guest = false;
    showScreen("auth");
    return;
  }
  const wasWaiting = state.starting;
  state.starting = false;
  leaveClass();
  if (wasWaiting) api("/api/classroom/leave", { method: "POST" }).catch(() => {});
  localStorage.removeItem("sh_token");
  state.profile = null;
  state.quota = null;
  showScreen("auth");
});

$$("[data-nav]").forEach((button) => button.addEventListener("click", () => {
  if (state.guest) {
    toast("Register to use the rest of the desk.");
    return;
  }
  showView(button.dataset.nav);
  if (button.dataset.nav === "today") ensurePlan();
}));
$("#go-home").addEventListener("click", () => {
  if (state.guest) return;
  showView("today");
  ensurePlan();
});
$("#open-class").addEventListener("click", () => {
  if (state.guest) return;
  showView("class");
});
$$("[data-lang]").forEach((button) => button.addEventListener("click", () => setLanguage(button.dataset.lang)));
$("#open-info").addEventListener("click", () => $("#info-modal").showModal());

$("#today-go").addEventListener("click", async (event) => {
  const action = event.currentTarget.dataset.action;
  if (action === "exercise-open") {
    showView("exercises");
  } else if (action === "exercise-new") {
    showView("exercises");
    const button = $("#form-exercise button");
    busy(button, true, "Your teacher is writing it…");
    try { await requestExercise(); renderExerciseView(); } catch (err) { toast(err.message); } finally { busy(button, false); }
  } else {
    showView("class");
    beginClass();
  }
});
$("#today-notes").addEventListener("click", () => {
  showView("tutor");
  $("#file-input").focus();
});

$("#form-chat").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  addMessage("user", message);
  state.history.push({ role: "user", content: message });
  input.value = "";
  const button = event.target.querySelector("button");
  busy(button, true, "Thinking…");
  try {
    const data = await api("/api/chat", {
      method: "POST",
      json: { message, history: state.history.slice(0, -1), language: state.language },
    });
    state.history.push({ role: "assistant", content: data.reply });
    addMessage("assistant", data.reply);
  } catch (err) {
    state.history.pop();
    addMessage("assistant", err.message);
  }
  finally { busy(button, false); }
});
$("#chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#form-chat").requestSubmit();
  }
});

$("#file-input").addEventListener("change", () => {
  const file = $("#file-input").files[0];
  const label = $("#file-label");
  if (!file) {
    label.textContent = "Choose PDF, DOCX or photo";
    return;
  }
  const mb = (file.size / 1048576).toFixed(1);
  label.textContent = file.size > MAX_PART ? `${file.name} (${mb} MB — will be split)` : `${file.name} (${mb} MB)`;
});

$("#form-upload").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.uploading) return;
  const file = $("#file-input").files[0];
  if (!file) {
    toast("Choose a file first.");
    return;
  }
  const button = event.target.querySelector("button");
  const status = $("#upload-status");
  state.uploading = true;
  busy(button, true, "Working…");
  try {
    status.textContent = file.size > MAX_PART ? "Splitting the file into parts under 1 MB…" : "Reading your notes…";
    const parts = await uploadNotes(file, status);
    event.target.reset();
    $("#file-label").textContent = "Choose PDF, DOCX or photo";
    toast(parts > 1 ? `Added ${file.name} in ${parts} parts.` : `Added ${file.name} to your notes.`);
    ensurePlan(true);
  } catch (err) {
    status.textContent = "";
    toast(err.message);
  } finally {
    state.uploading = false;
    busy(button, false);
  }
});

$("#edit-profile").addEventListener("click", () => {
  fillProfileForm();
  showScreen("profile");
});

$("#form-exercise").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.materials.length) {
    toast("Upload your notes first. Your teacher sets practice from them.");
    return;
  }
  const button = event.target.querySelector("button");
  busy(button, true, "Your teacher is writing it…");
  try {
    await requestExercise();
    renderExerciseView();
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

$("#answer-file").addEventListener("change", () => {
  const file = $("#answer-file").files[0];
  $("#answer-file-label").textContent = file ? file.name : "Optional answer sheet (PDF or photo, up to 1 MB)";
});

$("#form-answers").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.exercise) return;
  const button = event.target.querySelector("button[type=submit]");
  busy(button, true, "Grading…");
  try {
    let file = $("#answer-file").files[0];
    if (file && file.size > MAX_PART) {
      if (file.type.startsWith("image/")) {
        const small = await shrinkImage(file);
        file = new File([small.blob], small.name, { type: "image/jpeg" });
      } else {
        throw new Error("Keep the answer sheet under 1 MB. Photos are shrunk for you; for a PDF, export a smaller one.");
      }
    }
    let data;
    if (file) {
      const form = new FormData();
      form.append("exerciseId", state.exercise.id);
      form.append("answers", JSON.stringify(collectAnswers()));
      form.append("file", file);
      data = await api("/api/exercises/grade", { method: "POST", form });
    } else {
      data = await api("/api/exercises/grade", {
        method: "POST",
        json: { exerciseId: state.exercise.id, answers: collectAnswers() },
      });
    }
    state.exercise.graded = true;
    const row = (state.teacher.exercises || []).find((item) => item.id === state.exercise.id);
    if (row) row.graded = true;
    state.teacher.results = [...(state.teacher.results || []), {
      topic: state.exercise.topic,
      subject: state.exercise.subject,
      score: data.grade.score,
      max: data.grade.maxScore,
    }].slice(-8);
    state.teacher.planStale = true;
    renderGrade(data.grade);
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

$("#start-class").addEventListener("click", beginClass);
$("#queue-leave").addEventListener("click", () => {
  state.starting = false;
  hideQueue();
  api("/api/classroom/leave", { method: "POST" }).catch(() => {});
  toast("You left the line.");
});
$("#queue-notes").addEventListener("click", () => showView("tutor"));

function startSample() {
  unlockSpeech();
  if (state.language === "ny") toast("This sample board is in English. A live class will teach in Chichewa.");
  state.guest = !localStorage.getItem("sh_token");
  const lesson = { ...SAMPLE_LESSON, language: "en", segments: SAMPLE_LESSON.segments.map((segment) => ({ ...segment, elements: segment.elements.map((el) => ({ ...el })) })) };
  state.lesson = lesson;
  if (!state.profile) {
    showScreen("app");
    $("#guest-note").hidden = false;
    $("#sign-out").textContent = "Back";
    $$("[data-nav]").forEach((button) => { button.setAttribute("aria-current", "false"); });
    renderQuota();
  }
  showView("class");
  playLesson(lesson);
}

$("#sample-class").addEventListener("click", startSample);
$("#preview-board").addEventListener("click", startSample);

$("#class-pause").addEventListener("click", () => {
  state.pause = !state.pause;
  $("#class-pause").textContent = state.pause ? "Resume" : "Pause";
  if (!window.speechSynthesis) return;
  if (state.pause) window.speechSynthesis.pause();
  else window.speechSynthesis.resume();
});
$("#class-next").addEventListener("click", () => {
  state.skip = true;
  state.hold = false;
  state.pause = false;
  $("#hand-panel").hidden = true;
  window.speechSynthesis?.cancel();
});
$("#raise-hand").addEventListener("click", () => {
  state.hold = true;
  window.speechSynthesis?.cancel();
  $("#hand-panel").hidden = false;
  $("#hand-answer").hidden = true;
  $("#hand-continue").hidden = true;
  $("#hand-text").focus();
});
$("#hand-cancel").addEventListener("click", () => {
  state.hold = false;
  $("#hand-panel").hidden = true;
  state.recog?.abort?.();
});
$("#hand-continue").addEventListener("click", () => {
  state.hold = false;
  $("#hand-panel").hidden = true;
});
$("#hand-listen").addEventListener("click", () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast("This browser cannot use the microphone here. Type the question instead.");
    return;
  }
  state.recog?.abort?.();
  const recog = new SR();
  state.recog = recog;
  recog.lang = state.language === "ny" ? "ny-MW" : "en-US";
  recog.interimResults = false;
  recog.onresult = (event) => {
    $("#hand-text").value = event.results[0][0].transcript;
  };
  recog.onerror = () => toast("The microphone did not catch that. Type the question instead.");
  recog.start();
});
$("#hand-send").addEventListener("click", async () => {
  const question = $("#hand-text").value.trim();
  if (!question) {
    toast("Ask something first.");
    return;
  }
  const button = $("#hand-send");
  busy(button, true, "Thinking…");
  try {
    let answer = "Hold that thought. On the sample board I cannot call the teacher — register, upload your notes, and raise your hand in a live class.";
    let speech = "Ask me again once the live class is connected.";
    if (!state.guest && state.lesson && state.lesson !== SAMPLE_LESSON) {
      const data = await api("/api/classroom/ask", {
        method: "POST",
        json: {
          question,
          language: state.lesson.language || state.language,
          subject: state.lesson.subject,
          topic: state.lesson.topic,
          recent: recentBoardText(),
        },
      });
      answer = data.answer;
      speech = data.speech;
    }
    const box = $("#hand-answer");
    box.hidden = false;
    box.innerHTML = markdown(answer);
    $("#hand-continue").hidden = false;
    unlockSpeech();
    await speak(speech, state.lesson?.language || state.language, state.runId);
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});
$("#class-leave").addEventListener("click", () => {
  leaveClass();
  $("#class-room").hidden = true;
  $("#class-setup").hidden = false;
  $("#hand-panel").hidden = true;
  if (state.guest) {
    state.guest = false;
    showScreen("auth");
    return;
  }
  renderClassSetup();
});

window.addEventListener("pagehide", () => {
  if ((state.lessonActive || state.starting) && !state.guest) {
    try {
      fetch("/api/classroom/leave", {
        method: "POST",
        keepalive: true,
        headers: { Authorization: `Bearer ${localStorage.getItem("sh_token") || ""}` },
      });
    } catch { /* the seat frees itself after a minute */ }
  }
});

boot();
