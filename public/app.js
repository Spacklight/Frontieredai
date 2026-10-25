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
};

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
  if (!res.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = res.status;
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
  return Boolean(profile && profile.name && profile.grade && profile.examDate && profile.age && profile.subjects?.length);
}

function setLanguage(lang) {
  state.language = lang === "ny" ? "ny" : "en";
  localStorage.setItem("sh_lang", state.language);
  $$("[data-lang]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.lang === state.language)));
  const note = $("#class-lang-note");
  if (note) {
    note.textContent = state.language === "ny"
      ? "This class will be taught in Chichewa. Speech uses a Chichewa voice when the device has one."
      : "This class will be taught in English. You can switch to Chichewa before you start.";
  }
}

function showView(name) {
  if (name !== "class") stopLesson();
  $$("[data-view]").forEach((view) => { view.hidden = view.dataset.view !== name; });
  $$("[data-nav]").forEach((button) => button.setAttribute("aria-current", button.dataset.nav === name ? "page" : "false"));
  if (name === "timetable") renderTimetable();
  if (name === "vision") renderVision();
  if (name === "exercises") prepExerciseForm();
  if (name === "class") prepClassForm();
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

function fillProfileForm() {
  const form = $("#form-profile");
  const profile = state.profile || {};
  form.name.value = profile.name || "";
  form.age.value = profile.age || "";
  form.grade.value = profile.grade || "";
  form.examDate.value = profile.examDate || "";
  form.studyHours.value = profile.studyHours || 2;
  state.subjects = [...(profile.subjects || [])];
  renderSubjects();
}

function enterApp() {
  state.guest = false;
  $("#guest-note").hidden = true;
  $("#sign-out").textContent = "Sign out";
  showScreen("app");
  const name = state.profile?.name || state.profile?.username || "";
  $("#tutor-title").textContent = name ? `What are we taking next, ${name.split(" ")[0]}?` : "Ask one step at a time";
  if (!$("#thread").childElementCount) {
    addMessage("assistant", "Bring a question or a page from your notes. I will take one step, then you try the next.");
  }
  renderMaterials();
  renderTimetable();
  renderVision();
  prepClassForm();
  prepExerciseForm();
  showView("tutor");
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
    empty.textContent = "No notes yet. Upload a PDF or DOCX and I will pull out the topics.";
    list.append(empty);
    return;
  }
  state.materials.forEach((material) => {
    const item = document.createElement("li");
    item.className = "material";
    const title = document.createElement("h3");
    title.textContent = material.name;
    const meta = document.createElement("p");
    meta.textContent = material.subject;
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
      } catch (err) { toast(err.message); }
    });
    item.append(title, meta, topics, remove);
    list.append(item);
  });
}

function renderTimetable() {
  const grid = $("#week-grid");
  const summary = $("#week-summary");
  const timetable = state.teacher?.timetable || readLocal("sh_timetable");
  grid.innerHTML = "";
  if (!timetable?.days?.length) {
    summary.textContent = "Nothing planned yet. Build a week from your study hours, subjects, and exam date.";
    return;
  }
  summary.textContent = timetable.summary || "";
  timetable.days.forEach((day) => {
    const card = document.createElement("article");
    card.className = "day";
    const title = document.createElement("h3");
    title.textContent = day.day;
    card.append(title);
    if (!day.blocks?.length) {
      const rest = document.createElement("p");
      rest.className = "muted";
      rest.textContent = "Lighter day";
      card.append(rest);
    }
    (day.blocks || []).forEach((block) => {
      const node = document.createElement("div");
      node.className = "block";
      const when = document.createElement("strong");
      when.textContent = [block.start, block.end].filter(Boolean).join("–");
      const task = document.createElement("span");
      task.textContent = `${block.subject ? block.subject + ": " : ""}${block.task}`;
      node.append(when, task);
      card.append(node);
    });
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
    label.textContent = "Add an exam date on your profile.";
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
  const vision = state.teacher?.vision || readLocal("sh_vision");
  const copy = $("#vision-copy");
  copy.className = "prose";
  copy.innerHTML = markdown(vision?.statement || "Rewrite this when you want a short picture of how the weeks ahead should feel.");
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
  const pending = state.teacher?.pendingClassSuggestion;
  const next = $("#next-class");
  if (pending?.topic) {
    next.hidden = false;
    $("#next-class-copy").textContent = pending.subject ? `${pending.subject}: ${pending.topic}` : pending.topic;
  } else next.hidden = true;
}

function prepExerciseForm() {
  const form = $("#form-exercise");
  if (form.subject && !form.subject.value) form.subject.value = state.profile?.subjects?.[0] || "";
}

function prepClassForm() {
  const form = $("#form-class");
  if (!form.subject.value) form.subject.value = state.profile?.subjects?.[0] || state.teacher?.pendingClassSuggestion?.subject || "";
  if (!form.topic.value && state.teacher?.pendingClassSuggestion?.topic) form.topic.value = state.teacher.pendingClassSuggestion.topic;
  setLanguage(state.language);
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

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
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
  if (!state.guest) {
    api("/api/classroom/complete", { method: "POST", json: { subject: lesson.subject, topic: lesson.topic } })
      .then(() => {
        const label = `${lesson.subject}: ${lesson.topic}`;
        const learned = new Set(state.teacher.learnedTopics || []);
        learned.add(label);
        state.teacher.learnedTopics = [...learned];
        state.teacher.pendingClassSuggestion = null;
      })
      .catch(() => {});
    toast("Class finished. That topic is marked as learned.");
  }
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

function stopLesson() {
  state.runId += 1;
  state.hold = false;
  state.pause = false;
  window.speechSynthesis?.cancel();
  state.recog?.abort?.();
}

function openClass(topic, subject) {
  showScreen("app");
  showView("class");
  if (topic) $("#form-class").topic.value = topic;
  if (subject) $("#form-class").subject.value = subject;
}

function recentBoardText() {
  return $("#board-stage")?.innerText?.slice(0, 1500) || "";
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
      : "Add GEMINI_API_KEY, GITHUB_TOKEN, GITHUB_OWNER, and AUTH_SECRET before accounts or lessons can be saved. The sample chalkboard still works.";
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
    const data = await api("/api/bootstrap");
    state.profile = data.profile;
    state.materials = data.materials || [];
    state.teacher = data.teacher || {};
    if (!profileComplete(data.profile)) {
      fillProfileForm();
      showScreen("profile");
    } else enterApp();
  } catch (err) {
    if (err.status !== 401) toast(err.message);
    showScreen("auth");
  }
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
    state.profile = data.profile;
    if (!profileComplete(data.profile)) {
      fillProfileForm();
      showScreen("profile");
    } else {
      const bootData = await api("/api/bootstrap");
      state.materials = bootData.materials || [];
      state.teacher = bootData.teacher || {};
      enterApp();
    }
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
    state.teacher = { announcements: [], learnedTopics: [], pendingClassSuggestion: null };
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

$("#form-profile").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.subjects.length) {
    toast("Add at least one subject.");
    return;
  }
  const form = event.target;
  const button = form.querySelector("button[type=submit]");
  busy(button, true, "Saving…");
  try {
    const data = await api("/api/profile", {
      method: "PUT",
      json: {
        name: form.name.value,
        age: Number(form.age.value),
        grade: form.grade.value,
        examDate: form.examDate.value,
        studyHours: Number(form.studyHours.value),
        subjects: state.subjects,
      },
    });
    state.profile = data.profile;
    if (!state.materials.length && !state.teacher.announcements) {
      try {
        const bootData = await api("/api/bootstrap");
        state.materials = bootData.materials || [];
        state.teacher = bootData.teacher || {};
      } catch { /* tutor still opens */ }
    }
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
    stopLesson();
    state.guest = false;
    showScreen("auth");
    return;
  }
  localStorage.removeItem("sh_token");
  stopLesson();
  state.profile = null;
  showScreen("auth");
});

$$("[data-nav]").forEach((button) => button.addEventListener("click", () => {
  if (state.guest) {
    toast("Register to use the rest of the desk.");
    return;
  }
  showView(button.dataset.nav);
}));
$("#go-tutor").addEventListener("click", () => {
  if (state.guest) return;
  showView("tutor");
});
$("#open-class").addEventListener("click", () => {
  if (state.guest) return;
  showView("class");
});
$$("[data-lang]").forEach((button) => button.addEventListener("click", () => setLanguage(button.dataset.lang)));
$("#open-info").addEventListener("click", () => $("#info-modal").showModal());

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
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});
$("#chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#form-chat").requestSubmit();
  }
});

$("#form-upload").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("#file-input").files[0];
  if (!file) {
    toast("Choose a file first.");
    return;
  }
  const form = new FormData();
  form.append("file", file);
  form.append("subject", event.target.subject.value.trim());
  const button = event.target.querySelector("button");
  busy(button, true, "Reading…");
  try {
    const data = await api("/api/materials/upload", { method: "POST", form });
    state.materials.push(data.material);
    renderMaterials();
    event.target.reset();
    toast(`Found ${data.material.topics.length} topics in ${data.material.name}.`);
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

$("#build-week").addEventListener("click", async () => {
  const button = $("#build-week");
  busy(button, true, "Planning…");
  try {
    const data = await api("/api/timetable/generate", { method: "POST", json: { language: state.language } });
    state.teacher.timetable = data.timetable;
    localStorage.setItem("sh_timetable", JSON.stringify(data.timetable));
    renderTimetable();
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

$("#refresh-vision").addEventListener("click", async () => {
  const button = $("#refresh-vision");
  busy(button, true, "Writing…");
  try {
    const data = await api("/api/vision/refresh", { method: "POST", json: {} });
    state.teacher.vision = data.vision;
    state.teacher.announcements = data.announcements;
    if (data.vision?.nextTopic) {
      state.teacher.pendingClassSuggestion = { topic: data.vision.nextTopic, subject: data.vision.nextSubject || "" };
    }
    localStorage.setItem("sh_vision", JSON.stringify(data.vision));
    renderVision();
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

$("#edit-profile").addEventListener("click", () => {
  fillProfileForm();
  showScreen("profile");
});
$("#teach-next").addEventListener("click", () => {
  const pending = state.teacher.pendingClassSuggestion || {};
  openClass(pending.topic, pending.subject);
});

$("#form-exercise").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  busy(button, true, "Writing questions…");
  try {
    const data = await api("/api/exercises/generate", {
      method: "POST",
      json: {
        subject: event.target.subject.value,
        topic: event.target.topic.value,
        language: state.language,
      },
    });
    state.exercise = data.exercise;
    renderQuestions(data.exercise);
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

$("#form-answers").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.exercise) return;
  const button = event.target.querySelector("button[type=submit]");
  busy(button, true, "Grading…");
  try {
    const file = $("#answer-file").files[0];
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
    renderGrade(data.grade);
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

$("#form-class").addEventListener("submit", async (event) => {
  event.preventDefault();
  unlockSpeech();
  const form = event.target;
  const button = $("#start-class");
  busy(button, true, "Setting the board…");
  try {
    const data = await api("/api/classroom/start", {
      method: "POST",
      json: { subject: form.subject.value, topic: form.topic.value, language: state.language },
    });
    state.lesson = data.lesson;
    state.guest = false;
    await playLesson(data.lesson);
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

$("#suggest-topic").addEventListener("click", async () => {
  const button = $("#suggest-topic");
  busy(button, true, "Looking…");
  try {
    const data = await api("/api/classroom/suggest", { method: "POST", json: {} });
    $("#form-class").subject.value = data.suggestion.subject || "";
    $("#form-class").topic.value = data.suggestion.topic || "";
    if (data.suggestion.reason) toast(data.suggestion.reason);
    state.teacher.pendingClassSuggestion = data.suggestion;
  } catch (err) { toast(err.message); }
  finally { busy(button, false); }
});

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
    let answer = "Hold that thought. On the sample board I cannot call the tutor — register, add your keys, and raise your hand in a live class.";
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
  stopLesson();
  $("#class-room").hidden = true;
  $("#class-setup").hidden = false;
  $("#hand-panel").hidden = true;
  if (state.guest) {
    state.guest = false;
    showScreen("auth");
  }
});

boot();
