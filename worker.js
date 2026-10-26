/**
 * Study Helper — Cloudflare Worker.
 * Vanilla frontend is served through the ASSETS binding.
 * Student data lives as JSON in a GitHub repo. AI calls go to Google AI Studio (Gemini)
 * through the coordinator (see coordinator.js): a pool of keys/models, per-student daily
 * limits, and turn-taking for live classes.
 *
 * Temperature / topP / topK are omitted on purpose: Gemini 3.5 Flash-Lite rejects them.
 */

import { Coordinator, CoordCore, memoryStorage } from "./coordinator.js";

export { Coordinator };

const FILES = {
  profiles: "profiles.json",
  materials: "materials.json",
  teacher: "teacher-states.json",
};

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_UPLOAD_BYTES = 1024 * 1024; // 1 MB per uploaded part
const NOTES_LIMIT_CHARS = 400_000; // stored notes per student
const LEVELS = ["primary", "junior-secondary", "senior-secondary", "college", "other"];
const LEVEL_LABELS = {
  primary: "Primary school",
  "junior-secondary": "Junior secondary (e.g. JCE, Form 1–2)",
  "senior-secondary": "Senior secondary (e.g. MSCE, Form 3–4)",
  college: "College / university",
  other: "Other",
};

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        const res = await handleApi(request, env, ctx, url);
        return withCors(res, cors);
      }
      if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
        return json({ error: "ASSETS binding is missing. Check wrangler.jsonc." }, 500, cors);
      }
      return withCors(await env.ASSETS.fetch(request), cors);
    } catch (err) {
      const status = Number(err.status) || 500;
      const expose = err instanceof HttpError;
      const message = expose ? err.message : "Something went wrong. " + (err.message || "Unknown error");
      return json({ error: message, ...(expose ? err.extra : {}) }, status, cors);
    }
  },
};

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withCors(res, cors) {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** JSON reply that also carries the student's remaining daily teacher requests. */
function answer(data, meter, status = 200) {
  const q = meter?.quota;
  const quota = q
    ? { used: q.used, limit: q.limit, remaining: Math.max(0, q.limit - q.used), resetAt: q.resetAt }
    : undefined;
  return json(quota ? { ...data, quota } : data, status);
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

async function handleApi(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;
  const gh = createGithub(env);

  if (method === "GET" && path === "/api/setup") return json(await setupStatus(env));
  if (method === "POST" && path === "/api/auth/register") return register(request, env, gh);
  if (method === "POST" && path === "/api/auth/login") return login(request, env, gh);
  if (method === "POST" && path === "/api/admin/login") return adminLogin(request, env);

  if (path.startsWith("/api/admin/")) {
    await requireAdmin(request, env);
    return handleAdmin(request, env, gh, url);
  }

  const user = await requireUser(request, env, gh);
  if (!user) throw new HttpError(401, "Log in again.");

  if (method === "GET" && path === "/api/bootstrap") return bootstrap(env, user, gh);
  if (method === "GET" && path === "/api/quota") return json({ quota: await quotaFor(env, user) });
  if (method === "GET" && path === "/api/profile") return json({ profile: publicProfile(user) });
  if (method === "PUT" && path === "/api/profile") return updateProfile(request, user, gh);
  if (method === "POST" && path === "/api/chat") return chat(request, env, user, gh);
  if (method === "GET" && path === "/api/materials") return json({ materials: await listMaterials(user, gh) });
  if (method === "POST" && path === "/api/materials/upload") return uploadMaterial(request, env, user, gh);
  if (method === "DELETE" && path === "/api/materials") return deleteMaterial(request, user, gh);
  if (method === "POST" && path === "/api/teacher/plan") return planTeacher(request, env, user, gh);
  if (method === "POST" && path === "/api/classroom/start") return startClass(request, env, user, gh);
  if (method === "POST" && path === "/api/classroom/heartbeat") return classHeartbeat(env, user);
  if (method === "POST" && path === "/api/classroom/leave") return classLeave(env, user);
  if (method === "POST" && path === "/api/classroom/ask") return askClass(request, env, user, gh);
  if (method === "POST" && path === "/api/classroom/complete") return completeClass(request, env, user, gh);
  if (method === "POST" && path === "/api/exercises/generate") return generateExercises(request, env, user, gh);
  if (method === "POST" && path === "/api/exercises/grade") return gradeExercises(request, env, user, gh);

  throw new HttpError(404, "No such API route.");
}

async function setupStatus(env) {
  const owner = (env.GITHUB_OWNER || "").trim();
  const repo = (env.GITHUB_REPO || "aidata").trim();
  const ownerOk = Boolean(owner) && owner !== "your-github-username";
  let pool = { entries: env.GEMINI_API_KEY ? 1 : 0, health: { status: "ok", message: "" } };
  try {
    pool = await coordCall(env, "poolInfo");
  } catch { /* the coordinator is optional for the setup banner */ }
  const gemini = Boolean(env.GEMINI_API_KEY) || pool.entries > 0;
  const github = Boolean(env.GITHUB_TOKEN) && ownerOk;
  return {
    ok: gemini && github && Boolean(authSecret(env)),
    gemini,
    github,
    repo: ownerOk ? `${owner}/${repo}` : "",
    model: env.GEMINI_MODEL || DEFAULT_MODEL,
    admin: Boolean(env.ADMIN_SECRET),
    health: pool.health,
  };
}

function assertStorage(env) {
  const owner = (env.GITHUB_OWNER || "").trim();
  const ownerOk = Boolean(owner) && owner !== "your-github-username";
  if (!env.GITHUB_TOKEN || !ownerOk) {
    throw new HttpError(500, "Set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO before accounts can be saved.");
  }
  if (!authSecret(env)) {
    throw new HttpError(500, "Set AUTH_SECRET (wrangler secret put AUTH_SECRET).");
  }
}

/* ------------------------------------------------------------------ */
/* Accounts and profile                                                */
/* ------------------------------------------------------------------ */

async function register(request, env, gh) {
  assertStorage(env);
  const body = await readJson(request);
  const username = cleanUsername(body.username);
  const password = String(body.password || "");
  if (password.length < 6) throw new HttpError(400, "Use at least 6 characters for the password.");
  const passwordHash = await hashPassword(username, password);
  const profile = {
    id: crypto.randomUUID(),
    username,
    passwordHash,
    name: "",
    age: null,
    grade: "",
    level: "",
    examBoard: "",
    institution: "",
    course: "",
    subjects: [],
    examDate: "",
    studyHours: 2,
    avatarUpdatedAt: new Date().toISOString(),
  };
  applyProfileFields(profile, body);
  await gh.updateJson(FILES.profiles, [], (rows) => {
    if (rows.some((row) => row.username === username)) {
      throw new HttpError(409, "That username is taken.");
    }
    rows.push(profile);
    return rows;
  });
  await gh.updateJson(FILES.materials, [], (rows) => {
    if (!rows.some((row) => row.profileId === profile.id)) rows.push({ profileId: profile.id, materials: [] });
    return rows;
  });
  await gh.updateJson(FILES.teacher, [], (rows) => {
    ensureTeacher(rows, profile.id);
    return rows;
  });
  const token = await signToken({ sub: profile.id, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }, authSecret(env));
  return json({ token, profile: publicProfile(profile) }, 201);
}

async function login(request, env, gh) {
  assertStorage(env);
  const body = await readJson(request);
  const username = cleanUsername(body.username);
  const password = String(body.password || "");
  const passwordHash = await hashPassword(username, password);
  const { data: profiles } = await gh.readGitHubFile(FILES.profiles, []);
  const user = profiles.find((row) => row.username === username);
  if (!user || !safeEqual(user.passwordHash || "", passwordHash)) {
    throw new HttpError(401, "Username or password is wrong.");
  }
  const token = await signToken({ sub: user.id, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }, authSecret(env));
  return json({ token, profile: publicProfile(user) });
}

/** Copies the profile fields that were sent in `body` onto `row` (after cleaning). */
function applyProfileFields(row, body) {
  if (body.name !== undefined) row.name = clip(String(body.name || "").trim(), 80);
  if (body.age !== undefined) row.age = cleanAge(body.age);
  if (body.grade !== undefined) row.grade = clip(String(body.grade || "").trim(), 40);
  if (body.level !== undefined) row.level = cleanLevel(body.level);
  if (body.examBoard !== undefined) row.examBoard = clip(String(body.examBoard || "").trim(), 60);
  if (body.institution !== undefined) row.institution = clip(String(body.institution || "").trim(), 80);
  if (body.course !== undefined) row.course = clip(String(body.course || "").trim(), 80);
  if (body.subjects !== undefined) row.subjects = cleanSubjects(body.subjects);
  if (body.examDate !== undefined) row.examDate = cleanDate(body.examDate);
  if (body.studyHours !== undefined) row.studyHours = cleanHours(body.studyHours);
}

async function updateProfile(request, user, gh) {
  const body = await readJson(request);
  let saved = null;
  await gh.updateJson(FILES.profiles, [], (rows) => {
    const row = rows.find((item) => item.id === user.id);
    if (!row) throw new HttpError(404, "Profile not found.");
    applyProfileFields(row, body);
    row.avatarUpdatedAt = new Date().toISOString();
    saved = row;
    return rows;
  });
  return json({ profile: publicProfile(saved) });
}

async function bootstrap(env, user, gh) {
  const [materials, teacher, quota] = await Promise.all([
    listMaterials(user, gh),
    loadTeacher(user, gh),
    quotaFor(env, user),
  ]);
  return json({ profile: publicProfile(user), materials, teacher: sanitizeTeacher(teacher), quota });
}

async function quotaFor(env, user) {
  try {
    return await coordCall(env, "userStatus", { userId: user.id });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Prompt building blocks                                              */
/* ------------------------------------------------------------------ */

const SOURCE_RULE = [
  "SOURCE RULE (strict): the student's own uploaded notes, shown under NOTES, are the ONLY source of subject content.",
  "Every fact, definition, formula, example, name, date and question you give must come from NOTES.",
  "Never add outside facts, never fill gaps from general knowledge, never bring in new examples that carry new facts.",
  "If NOTES do not cover something, say so plainly and tell the student to upload those notes. Do not guess.",
  "You may use teaching skill: choose the order, simplify wording, rephrase the notes' own content, pace, and check understanding.",
].join("\n");

const TEACHER_ROLE = [
  "You are the student's teacher. The student does not tell you what to do — you decide.",
  "You decide what to teach next, how long to spend, when to give practice, how hard it should be, and when to revise.",
  "Make each decision yourself, as an experienced teacher would, and give a short reason when asked.",
].join("\n");

function langLine(language) {
  return language === "ny"
    ? "Write for the student in natural Chichewa (Chinyanja) that a Malawian student can follow. Keep formulas, numerals and unavoidable technical terms, then explain them in Chichewa."
    : "Write for the student in clear English.";
}

function profileBlurb(user) {
  const p = publicProfile(user);
  const college = p.level === "college";
  return [
    `Student: ${p.name || p.username}`,
    p.age ? `Age: ${p.age}` : "",
    p.level ? `Level: ${LEVEL_LABELS[p.level]}` : "",
    p.grade ? `${college ? "Year / semester" : "Class / form"}: ${p.grade}` : "",
    college && p.institution ? `Institution: ${p.institution}` : "",
    college && p.course ? `Programme: ${p.course}` : "",
    p.examBoard
      ? `Examining body: ${p.examBoard}. Use it only to set the level, command words, mark style and question formats. It is not a source of facts.`
      : "",
    p.subjects?.length ? `${college ? "Courses / modules" : "Subjects"}: ${p.subjects.join(", ")}` : "",
    p.examDate ? `Exam date: ${p.examDate} (${daysLeftText(p.examDate)})` : "No exam date set.",
    `Study hours a day: ${p.studyHours}`,
  ].filter(Boolean).join("\n");
}

function malawiToday() {
  const d = new Date(Date.now() + 2 * 3600 * 1000);
  return {
    date: d.toISOString().slice(0, 10),
    weekday: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()],
  };
}

function daysLeftText(date) {
  const today = malawiToday().date;
  const left = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (!Number.isFinite(left)) return "date unclear";
  if (left < 0) return "already passed";
  if (left === 0) return "today";
  return `${left} day${left === 1 ? "" : "s"} left`;
}

function outlineBlurb(materials) {
  if (!materials.length) return "OUTLINE: no uploaded materials.";
  return "OUTLINE of the student's notes:\n" + materials.map((material) => {
    const topics = (material.topics || []).map((topic) => {
      const subs = (topic.subtopics || []).slice(0, 5).join(", ");
      return subs ? `${topic.name} (${subs})` : topic.name;
    }).join("; ");
    return `- ${material.subject}: ${material.name} — ${topics}`;
  }).join("\n");
}

function learnedBlurb(teacher) {
  const learned = (teacher.learnedTopics || []).slice(-15).join("; ") || "nothing yet";
  const results = (teacher.results || []).slice(-6)
    .map((r) => `${r.subject}: ${r.topic} → ${r.score}/${r.max}`).join("; ");
  return `Already taught: ${learned}\nRecent exercise results: ${results || "none yet"}`;
}

function notesSection(chunks) {
  return chunks ? `NOTES (the only allowed source):\n${chunks}` : "NOTES: (none uploaded yet)";
}

/** Picks the parts of the student's notes that matter for `query`, within `budget` characters. */
function notesContext(items, query, budget = 14000) {
  const chunks = [];
  for (const item of items) {
    const label = item.parts > 1 ? `${item.name}, part ${item.part}` : item.name;
    const paras = String(item.text || "").split(/\n{2,}/);
    let buf = "";
    const flush = () => {
      if (buf) chunks.push({ label, text: buf });
      buf = "";
    };
    for (const para of paras) {
      for (let at = 0; at < para.length || at === 0; at += 1400) {
        const piece = para.slice(at, at + 1400);
        if (buf && (buf + piece).length > 1500) flush();
        buf += (buf ? "\n\n" : "") + piece;
        if (!para.length) break;
      }
    }
    flush();
  }
  if (!chunks.length) return "";
  chunks.forEach((chunk, index) => { chunk.i = index; });
  const words = [...new Set(String(query || "").toLowerCase().match(/[a-z0-9À-ɏ]{4,}/g) || [])];
  words.length && chunks.forEach((chunk) => {
    const low = chunk.text.toLowerCase();
    chunk.score = words.reduce((sum, word) => sum + (low.includes(word) ? 1 : 0), 0);
  });
  let chosen;
  if (words.length && chunks.some((chunk) => chunk.score > 0)) {
    chosen = [...chunks].sort((a, b) => b.score - a.score || a.i - b.i);
  } else {
    const maxChunks = Math.max(1, Math.floor(budget / 1400));
    const step = Math.max(1, Math.ceil(chunks.length / maxChunks));
    chosen = chunks.filter((_, index) => index % step === 0);
  }
  const out = [];
  let used = 0;
  for (const chunk of chosen) {
    if (used + chunk.text.length > budget && out.length) continue;
    out.push(chunk);
    used += chunk.text.length;
    if (used >= budget) break;
  }
  out.sort((a, b) => a.i - b.i);
  return out.map((chunk) => `[${chunk.label}]\n${chunk.text}`).join("\n\n---\n\n");
}

function requireNotes(items) {
  if (!items.length) {
    throw new HttpError(
      409,
      "Upload your notes first. Your teacher teaches only from the notes you upload.",
      { code: "no_notes" },
    );
  }
}

function nextUnlearnedTopic(materials, learned) {
  const done = new Set((learned || []).map((item) => String(item).toLowerCase()));
  let first = null;
  for (const material of materials) {
    for (const topic of material.topics || []) {
      first ||= { subject: material.subject, topic: topic.name };
      const label = `${material.subject}: ${topic.name}`.toLowerCase();
      if (!done.has(label) && !done.has(String(topic.name).toLowerCase())) {
        return { subject: material.subject, topic: topic.name };
      }
    }
  }
  return first;
}

/* ------------------------------------------------------------------ */
/* Tutor chat                                                          */
/* ------------------------------------------------------------------ */

async function chat(request, env, user, gh) {
  const body = await readJson(request);
  const message = clip(String(body.message || "").trim(), 8000);
  if (!message) throw new HttpError(400, "Type a message first.");
  const language = body.language === "ny" ? "ny" : "en";
  const history = Array.isArray(body.history) ? body.history : [];
  const notes = await loadNotes(user, gh);
  requireNotes(notes);
  const query = [message, ...history.slice(-4).map((turn) => turn.content || turn.text || "")].join(" ");
  const system = [
    "[task:chat]",
    TEACHER_ROLE,
    "You are answering a question in the tutor chat. Teach step by step, one move at a time. When the student is stuck, hint before you explain.",
    "Use short markdown: paragraphs, a list when it helps. Do not open with 'Certainly' or a label like 'Tutor:'.",
    "If the question is not covered by NOTES, say: it is not in the uploaded notes, so you cannot teach it yet — then name what to upload.",
    "End with one small next step or check question that you choose.",
    SOURCE_RULE,
    langLine(language),
    profileBlurb(user),
    notesSection(notesContext(notes, query, 12000)),
  ].join("\n\n");
  const meter = {};
  const reply = await gemini(env, user, {
    system,
    contents: toContents(history, message),
    json: false,
    kind: "chat",
    meter,
  });
  return answer({ reply }, meter);
}

/* ------------------------------------------------------------------ */
/* Notes upload                                                        */
/* ------------------------------------------------------------------ */

async function uploadMaterial(request, env, user, gh) {
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") throw new HttpError(400, "Choose a PDF, DOCX, text file, or image.");
  const size = file.size || 0;
  if (size <= 0) throw new HttpError(400, "That file is empty.");
  if (size > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "Each upload must be 1 MB or smaller. Big PDFs are split in your browser first — reload the page and try again.");
  }
  const groupId = clip(String(form.get("groupId") || crypto.randomUUID()), 60);
  const displayName = clip(String(form.get("displayName") || file.name || "notes").trim(), 120);
  const part = Math.max(1, Math.min(60, Number(form.get("part")) || 1));
  const parts = Math.max(part, Math.min(60, Number(form.get("parts")) || 1));
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || guessMime(file.name || displayName);
  const piece = await fileToGeminiPart(file.name || displayName, mime, bytes);

  const existing = (await listMaterials(user, gh)).find((row) => row.groupId === groupId);
  const stored = await loadNotes(user, gh);
  const totalChars = stored.reduce((sum, item) => sum + (item.text || "").length, 0);
  if (totalChars >= NOTES_LIMIT_CHARS) {
    throw new HttpError(413, "Your notes library is full. Remove an old file before adding more.", { code: "notes_full" });
  }

  const needNotes = !piece.text;
  const system = [
    "[task:extract]",
    `You are reading part ${part} of ${parts} of a student's own study notes${parts > 1 ? ` (file: ${displayName})` : ""}.`,
    "Return JSON only: {\"subject\":\"\",\"topics\":[{\"name\":\"\",\"subtopics\":[\"\"]}],\"notes\":\"\"}",
    "topics: 2 to 8 topics that appear in THIS part, in the order they should be taught. Subtopics are short noun phrases. Use only what is in the file.",
    needNotes
      ? "notes: rewrite the file's study content as clean markdown in its original order and language: headings, bullet lists, every definition, formula and worked example, diagrams described in words. Add nothing that is not in the file. Keep it under 11000 characters; if the file is longer, keep the most examinable material."
      : "notes: return an empty string (the text is already stored).",
    existing ? `The subject so far is ${existing.subject}; keep it unless this part clearly belongs elsewhere.` : "subject: the most likely school or college subject.",
  ].join("\n");
  const contents = [{ role: "user", parts: [piece.text ? { text: clip(piece.text, 24000) } : piece, { text: "Extract the topics and notes." }] }];
  const meter = {};
  const raw = await geminiJson(env, user, { system, contents, kind: "upload", critical: true, meter });

  const topics = Array.isArray(raw.topics)
    ? raw.topics.slice(0, 12).map((topic) => ({
        name: clip(String(topic.name || "Topic").trim(), 80),
        subtopics: Array.isArray(topic.subtopics)
          ? topic.subtopics.slice(0, 8).map((item) => clip(String(item).trim(), 80)).filter(Boolean)
          : [],
      })).filter((topic) => topic.name)
    : [];
  const noteText = piece.text ? clip(piece.text, 60000) : clip(String(raw.notes || ""), 30000);
  if (!topics.length || noteText.trim().length < 20) {
    throw new HttpError(422, "Nothing readable came out of that file. Try a text-based PDF or a clearer photo.");
  }
  const subject = clip(String(raw.subject || existing?.subject || "General").trim(), 60);
  const materialId = existing?.id || crypto.randomUUID();

  let material = null;
  await gh.updateJson(FILES.materials, [], (rows) => {
    let bucket = rows.find((row) => row.profileId === user.id);
    if (!bucket) {
      bucket = { profileId: user.id, materials: [] };
      rows.push(bucket);
    }
    material = bucket.materials.find((row) => row.groupId === groupId);
    if (!material) {
      material = {
        id: materialId,
        groupId,
        name: displayName,
        subject,
        topics: [],
        parts: parts,
        partsDone: 0,
        addedAt: new Date().toISOString(),
      };
      bucket.materials.push(material);
    }
    const seen = new Set(material.topics.map((topic) => topic.name.toLowerCase()));
    for (const topic of topics) {
      if (!seen.has(topic.name.toLowerCase())) {
        material.topics.push(topic);
        seen.add(topic.name.toLowerCase());
      }
    }
    material.topics = material.topics.slice(0, 40);
    material.parts = Math.max(material.parts || 1, parts);
    material.partsDone = (material.partsDone || 0) + 1;
    return rows;
  });
  await gh.updateJson(notesFile(user), { items: [] }, (data) => {
    data.items = (data.items || []).filter((item) => !(item.materialId === material.id && item.part === part));
    data.items.push({ materialId: material.id, name: displayName, subject, part, parts, text: noteText });
    return data;
  });
  return answer({ material }, meter, 201);
}

async function deleteMaterial(request, user, gh) {
  const body = await readJson(request);
  const id = String(body.id || "");
  if (!id) throw new HttpError(400, "Missing material id.");
  await gh.updateJson(FILES.materials, [], (rows) => {
    const bucket = rows.find((row) => row.profileId === user.id);
    if (bucket) bucket.materials = (bucket.materials || []).filter((item) => item.id !== id);
    return rows;
  });
  await gh.updateJson(notesFile(user), { items: [] }, (data) => {
    data.items = (data.items || []).filter((item) => item.materialId !== id);
    return data;
  });
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* The teacher decides: plan                                           */
/* ------------------------------------------------------------------ */

async function planTeacher(request, env, user, gh) {
  const body = await readJson(request);
  const language = body.language === "ny" ? "ny" : "en";
  const materials = await listMaterials(user, gh);
  const notes = await loadNotes(user, gh);
  requireNotes(notes);
  const teacher = await loadTeacher(user, gh);
  const hours = cleanHours(user.studyHours);
  const today = malawiToday();
  const system = [
    "[task:plan]",
    TEACHER_ROLE,
    `Today is ${today.weekday} ${today.date} (Malawi time).`,
    "Plan the student's study yourself. Decide: the next thing to do right now, a 7-day timetable, a short vision, and announcements.",
    `The student can work about ${hours} hours on a study day. Choose how many study days and rest days they need, the block lengths (25 to 90 minutes), and the mix of activities.`,
    "Use activities: class (a live lesson), exercise (practice you will set), revision, reading. Put hard or new topics early, revise what was taught, and spend more time on weak results.",
    "If the exam is near, shift toward revision and exam practice in the examining body's style. For college, plan around course modules and semester exams.",
    "next.action is what the student should do now: class (teach a new topic), exercise (practice a topic just taught), or revise (go over a weak topic).",
    "Return JSON only:",
    '{"summary":"1-2 sentences","next":{"action":"class|exercise|revise","subject":"","topic":"","reason":"one sentence"},"timetable":{"days":[{"day":"Monday","blocks":[{"start":"16:00","end":"17:00","subject":"","task":"","activity":"class|exercise|revision|reading"}]}]},"vision":"2-3 sentences","announcements":["",""],"weakTopics":[""]}',
    "Days must be Monday through Sunday, times 24-hour HH:MM. Tasks are specific topics that exist in the OUTLINE, never invented chapters.",
    SOURCE_RULE,
    langLine(language),
    profileBlurb(user),
    learnedBlurb(teacher),
    outlineBlurb(materials),
    notesSection(notesContext(notes, "", 4000)),
  ].join("\n\n");
  const meter = {};
  const raw = await geminiJson(env, user, {
    system,
    contents: [{ role: "user", parts: [{ text: "Make your plan for this student." }] }],
    kind: "plan",
    critical: true,
    meter,
  });
  const plan = normalizePlan(raw, materials, teacher);
  const saved = await gh.updateJson(FILES.teacher, [], (rows) => {
    const row = ensureTeacher(rows, user.id);
    row.plan = { summary: plan.summary, next: plan.next, weakTopics: plan.weakTopics, updatedAt: plan.updatedAt };
    row.timetable = plan.timetable;
    row.vision = plan.vision;
    row.announcements = plan.announcements;
    row.needsReplan = false;
    return rows;
  });
  const row = saved.find((item) => item.profileId === user.id);
  return answer({ teacher: sanitizeTeacher(row) }, meter);
}

function normalizePlan(raw, materials, teacher) {
  const actions = new Set(["class", "exercise", "revise"]);
  const fallback = nextUnlearnedTopic(materials, teacher.learnedTopics) || { subject: "", topic: "" };
  const nextRaw = raw.next && typeof raw.next === "object" ? raw.next : {};
  const next = {
    action: actions.has(nextRaw.action) ? nextRaw.action : "class",
    subject: clip(String(nextRaw.subject || fallback.subject || "").trim(), 60),
    topic: clip(String(nextRaw.topic || fallback.topic || "").trim(), 140),
    reason: clip(String(nextRaw.reason || "").trim(), 260),
  };
  const updatedAt = new Date().toISOString();
  const timetable = normalizeTimetable(raw.timetable && typeof raw.timetable === "object" ? raw.timetable : raw);
  timetable.summary ||= clip(String(raw.summary || "").trim(), 400);
  return {
    summary: clip(String(raw.summary || "").trim(), 400),
    next,
    timetable,
    vision: { statement: clip(String(raw.vision || raw.statement || "").trim(), 600), updatedAt },
    announcements: (Array.isArray(raw.announcements) ? raw.announcements : []).slice(0, 4)
      .map((text) => ({ id: crypto.randomUUID(), text: clip(String(text).trim(), 220), at: updatedAt }))
      .filter((item) => item.text),
    weakTopics: (Array.isArray(raw.weakTopics) ? raw.weakTopics : []).slice(0, 6)
      .map((text) => clip(String(text).trim(), 100)).filter(Boolean),
    updatedAt,
  };
}

function normalizeTimetable(raw) {
  const order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const activities = new Set(["class", "exercise", "revision", "reading"]);
  const days = (Array.isArray(raw.days) ? raw.days : []).slice(0, 7).map((day, index) => ({
    day: clip(String(day.day || order[index] || "Day"), 20),
    blocks: (Array.isArray(day.blocks) ? day.blocks : []).slice(0, 8).map((block) => ({
      start: clip(String(block.start || ""), 8),
      end: clip(String(block.end || ""), 8),
      subject: clip(String(block.subject || ""), 40),
      task: clip(String(block.task || ""), 160),
      activity: activities.has(block.activity) ? block.activity : "reading",
    })).filter((block) => block.task),
  }));
  return { summary: clip(String(raw.summary || "").trim(), 400), days };
}

/* ------------------------------------------------------------------ */
/* Live class (turn-taking through the coordinator)                    */
/* ------------------------------------------------------------------ */

async function startClass(request, env, user, gh) {
  const body = await readJson(request);
  const language = body.language === "ny" ? "ny" : "en";
  const enter = await coordCall(env, "classEnter", { userId: user.id });
  if (enter.state === "closed") {
    throw busyError({ code: "pool_exhausted", resetAt: enter.resetAt });
  }
  if (enter.state === "waiting") {
    return json({
      queued: true,
      position: enter.position,
      etaMinutes: enter.etaMinutes,
      slots: enter.slots,
      active: enter.active,
      waiting: enter.waiting,
      message: `Class is full right now. You are number ${enter.position} in line — about ${enter.etaMinutes} minute${enter.etaMinutes === 1 ? "" : "s"}. Stay on this page and your class starts by itself.`,
    }, 202);
  }
  const meter = {};
  try {
    const materials = await listMaterials(user, gh);
    const notes = await loadNotes(user, gh);
    requireNotes(notes);
    const teacher = await loadTeacher(user, gh);
    const planned = teacher.plan?.next?.action === "class" ? teacher.plan.next : null;
    const candidate = planned?.topic
      ? { subject: planned.subject, topic: planned.topic }
      : nextUnlearnedTopic(materials, teacher.learnedTopics) || { subject: "", topic: "" };
    const system = [
      "[task:lesson]",
      TEACHER_ROLE,
      "You teach one live chalkboard class. Decide the topic yourself, the number of segments (8 to 16, about 10 to 20 minutes), the pace, and the drawings.",
      `Candidate topic from your own plan: ${candidate.subject ? candidate.subject + " — " : ""}${candidate.topic || "(none — choose from the OUTLINE)"}. Keep it unless another topic in NOTES is a better next step; always teach a topic that NOTES really cover.`,
      "Write every text field and every speech field in the requested language. Speech is what the teacher says aloud: one or two sentences, no markdown.",
      "Return JSON only with this shape:",
      '{"subject":"","topic":"","layout":"single|two|three","segments":[{"kind":"title|point|break","section":1,"elements":[{"type":"title","text":""},{"type":"text","text":""},{"type":"draw","shape":"circle|cycle|venn|ruler|protractor","nodes":[{"label":""}]}],"speech":""}],"followUp":{"exercise":true,"reason":""}}',
      "Rules: layout is single, two, or three. kind cycles through title, then points, with a break around the middle.",
      "Most segments have 1 to 3 elements. Use drawings only where they help, only the shapes listed. nodes are drawing labels: a cycle uses 3 to 5 steps, a venn 2 or 3 set names, a ruler or protractor measurement labels.",
      "Build ideas in order from NOTES. The last segment is a short check question in the speech.",
      "followUp.exercise: true if the student should practise this topic right after class, false if you would rather revise first.",
      SOURCE_RULE,
      langLine(language),
      profileBlurb(user),
      learnedBlurb(teacher),
      outlineBlurb(materials),
      notesSection(notesContext(notes, `${candidate.subject} ${candidate.topic}`, 15000)),
    ].join("\n\n");
    const raw = await geminiJson(env, user, {
      system,
      contents: [{ role: "user", parts: [{ text: `Teach the class now. Language: ${language}.` }] }],
      kind: "lesson",
      critical: true,
      meter,
    });
    const lesson = normalizeLesson(raw, { subject: candidate.subject, topic: candidate.topic, language });
    if (lesson.segments.length < 4) throw new HttpError(502, "The lesson came back too short. Start the class again.");
    return answer({ lesson }, meter);
  } catch (err) {
    await coordCall(env, "classLeave", { userId: user.id }).catch(() => {});
    throw err;
  }
}

async function classHeartbeat(env, user) {
  const res = await coordCall(env, "classBeat", { userId: user.id });
  return json({ ok: true, active: res.active });
}

async function classLeave(env, user) {
  await coordCall(env, "classLeave", { userId: user.id });
  return json({ ok: true });
}

async function askClass(request, env, user, gh) {
  const body = await readJson(request);
  const question = clip(String(body.question || "").trim(), 2000);
  if (!question) throw new HttpError(400, "Ask a question first.");
  const language = body.language === "ny" ? "ny" : "en";
  const notes = await loadNotes(user, gh);
  requireNotes(notes);
  await coordCall(env, "classBeat", { userId: user.id }).catch(() => {});
  const topic = clip(String(body.topic || ""), 140);
  const system = [
    "[task:ask]",
    TEACHER_ROLE,
    "A student raised their hand in your live chalkboard class. Answer in a short, kind way, then point them back to the lesson.",
    "Return JSON only: {\"answer\":\"markdown\",\"speech\":\"one or two sentences to read aloud\"}.",
    "If NOTES do not cover the question, say so and promise to come back to it once they upload those notes.",
    SOURCE_RULE,
    langLine(language),
    profileBlurb(user),
    `Subject: ${clip(String(body.subject || ""), 60)}`,
    `Topic: ${topic}`,
    `What was just on the board: ${clip(String(body.recent || ""), 1500)}`,
    notesSection(notesContext(notes, `${topic} ${question}`, 9000)),
  ].join("\n\n");
  const meter = {};
  const raw = await geminiJson(env, user, {
    system,
    contents: [{ role: "user", parts: [{ text: question }] }],
    kind: "ask",
    critical: true,
    meter,
  });
  return answer({
    answer: String(raw.answer || "Let's look at that together."),
    speech: String(raw.speech || raw.answer || ""),
  }, meter);
}

async function completeClass(request, env, user, gh) {
  const body = await readJson(request);
  const topic = clip(String(body.topic || "").trim(), 140);
  const subject = clip(String(body.subject || "").trim(), 60);
  await coordCall(env, "classLeave", { userId: user.id }).catch(() => {});
  if (!topic) return json({ ok: true });
  const label = subject ? `${subject}: ${topic}` : topic;
  await gh.updateJson(FILES.teacher, [], (rows) => {
    const row = ensureTeacher(rows, user.id);
    const learned = new Set(row.learnedTopics || []);
    learned.add(label);
    row.learnedTopics = [...learned].slice(-60);
    row.lastClass = { subject, topic, at: new Date().toISOString() };
    row.needsReplan = true;
    return rows;
  });
  return json({ ok: true, learned: label });
}

function normalizeLesson(raw, fallback) {
  const layouts = new Set(["single", "two", "three"]);
  const kinds = new Set(["title", "point", "break"]);
  const shapes = new Set(["circle", "cycle", "venn", "ruler", "protractor"]);
  const segments = (Array.isArray(raw.segments) ? raw.segments : []).slice(0, 18).map((segment) => {
    const elements = (Array.isArray(segment.elements) ? segment.elements : []).slice(0, 6).map((element) => {
      const type = element.type === "draw" ? "draw" : element.type === "title" ? "title" : "text";
      if (type === "draw") {
        const shape = shapes.has(element.shape) ? element.shape : "circle";
        const nodes = (Array.isArray(element.nodes) ? element.nodes : []).slice(0, 6).map((node) => {
          if (typeof node === "string") return { label: clip(node, 40) };
          return { label: clip(String(node.label || node.text || ""), 40) };
        }).filter((node) => node.label);
        return { type, shape, nodes };
      }
      return { type, text: clip(String(element.text || "").trim(), 500) };
    }).filter((element) => element.type === "draw" || element.text);
    const speech = clip(String(segment.speech || "").trim(), 500);
    if (!elements.length && speech) elements.push({ type: "text", text: speech });
    return {
      kind: kinds.has(segment.kind) ? segment.kind : "point",
      section: Number(segment.section) || 1,
      elements,
      speech,
    };
  }).filter((segment) => segment.elements.length || segment.speech);
  return {
    subject: clip(String(raw.subject || fallback.subject || "General"), 60),
    topic: clip(String(raw.topic || fallback.topic || "Lesson"), 140),
    layout: layouts.has(raw.layout) ? raw.layout : "single",
    language: fallback.language === "ny" ? "ny" : "en",
    followUp: {
      exercise: raw.followUp?.exercise !== false,
      reason: clip(String(raw.followUp?.reason || ""), 200),
    },
    segments,
  };
}

/* ------------------------------------------------------------------ */
/* Exercises: the teacher decides what and how much                    */
/* ------------------------------------------------------------------ */

async function generateExercises(request, env, user, gh) {
  const body = await readJson(request);
  const language = body.language === "ny" ? "ny" : "en";
  const materials = await listMaterials(user, gh);
  const notes = await loadNotes(user, gh);
  requireNotes(notes);
  const teacher = await loadTeacher(user, gh);
  const plan = teacher.plan?.next;
  const hint = clip(String(body.topic || "").trim(), 140)
    || (plan?.action !== "class" && plan?.topic ? plan.topic : "")
    || teacher.lastClass?.topic
    || nextUnlearnedTopic(materials, [])?.topic
    || "";
  const system = [
    "[task:exercise]",
    TEACHER_ROLE,
    "Set the student an exercise. Decide the topic, the number of questions (3 to 10), the mix of multiple-choice and essay questions, and the difficulty, the way a teacher sets homework after a lesson.",
    `Starting point: ${hint || "(none — pick the most useful topic from the OUTLINE)"}. Prefer something already taught, or a weak result; change it if another topic in NOTES needs practice more.`,
    "Use the examining body's question style and command words where it is given. All content must still come from NOTES.",
    "Return JSON only:",
    '{"title":"","subject":"","topic":"","difficulty":"easy|medium|hard","questions":[{"id":"q1","type":"mcq","prompt":"","choices":["","","",""],"answer":"","explanation":""},{"id":"q5","type":"essay","prompt":"","modelPoints":[""]}]}',
    "MCQ answer must be the exact choice text, not a letter. Exactly 4 choices. One correct choice.",
    "Essay modelPoints are the facts a strong answer includes, taken from NOTES. Do not reveal them in the prompt.",
    SOURCE_RULE,
    langLine(language),
    profileBlurb(user),
    learnedBlurb(teacher),
    outlineBlurb(materials),
    notesSection(notesContext(notes, hint, 12000)),
  ].join("\n\n");
  const meter = {};
  const raw = await geminiJson(env, user, {
    system,
    contents: [{ role: "user", parts: [{ text: "Set the exercise." }] }],
    kind: "exercise",
    critical: true,
    meter,
  });
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).slice(0, 10).map((item, index) => {
    const type = item.type === "essay" ? "essay" : "mcq";
    const id = clip(String(item.id || `q${index + 1}`), 12);
    if (type === "essay") {
      return {
        id,
        type,
        prompt: clip(String(item.prompt || "").trim(), 600),
        modelPoints: (Array.isArray(item.modelPoints) ? item.modelPoints : []).slice(0, 6).map((point) => clip(String(point), 200)),
      };
    }
    const choices = (Array.isArray(item.choices) ? item.choices : []).slice(0, 4).map((choice) => clip(String(choice), 180));
    return {
      id,
      type,
      prompt: clip(String(item.prompt || "").trim(), 600),
      choices,
      answer: clip(String(item.answer || ""), 180),
      explanation: clip(String(item.explanation || ""), 400),
    };
  }).filter((item) => item.prompt && (item.type === "essay" || item.choices.length === 4));
  if (questions.length < 3) throw new HttpError(502, "The exercise did not come back in a usable form. Try again.");
  const subject = clip(String(raw.subject || plan?.subject || teacher.lastClass?.subject || user.subjects?.[0] || "General").trim(), 60);
  const topic = clip(String(raw.topic || hint || "Practice").trim(), 140);
  const exercise = {
    id: crypto.randomUUID(),
    title: clip(String(raw.title || topic).trim(), 120),
    subject,
    topic,
    difficulty: ["easy", "medium", "hard"].includes(raw.difficulty) ? raw.difficulty : "medium",
    language,
    createdAt: new Date().toISOString(),
    questions,
  };
  await gh.updateJson(FILES.teacher, [], (rows) => {
    const row = ensureTeacher(rows, user.id);
    row.exercises = [...(row.exercises || []), exercise].slice(-8);
    return rows;
  });
  return answer({ exercise: publicExercise(exercise) }, meter, 201);
}

async function gradeExercises(request, env, user, gh) {
  const contentType = request.headers.get("content-type") || "";
  let exerciseId = "";
  let answers = [];
  let filePart = null;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    exerciseId = String(form.get("exerciseId") || "");
    try { answers = JSON.parse(String(form.get("answers") || "[]")); } catch { answers = []; }
    const file = form.get("file");
    if (file && typeof file !== "string" && file.size) {
      if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "Keep the answer sheet under 1 MB. Photos are shrunk in your browser; for a PDF, export a smaller one.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      filePart = await fileToGeminiPart(file.name || "answers", file.type || guessMime(file.name || ""), bytes);
    }
  } else {
    const body = await readJson(request);
    exerciseId = String(body.exerciseId || "");
    answers = Array.isArray(body.answers) ? body.answers : [];
  }
  const teacher = await loadTeacher(user, gh);
  const exercise = (teacher.exercises || []).find((item) => item.id === exerciseId);
  if (!exercise) throw new HttpError(404, "That exercise is not on file. Ask your teacher for a new one.");
  const system = [
    "[task:grade]",
    TEACHER_ROLE,
    "Grade the student fairly against the answer key. Partial credit is allowed on essays. Give feedback a good teacher would give.",
    "Return JSON only: {\"score\":0,\"maxScore\":0,\"summary\":\"\",\"questions\":[{\"id\":\"q1\",\"score\":0,\"max\":1,\"feedback\":\"\"}]}",
    "maxScore is the total of question max values. MCQ max is 1. Essay max is 3.",
    langLine(exercise.language),
    "Answer key JSON:\n" + JSON.stringify(exercise.questions),
    "Student typed answers JSON:\n" + JSON.stringify(answers).slice(0, 12000),
  ].join("\n\n");
  const parts = [{ text: filePart ? "Grade the typed answers and the uploaded answer sheet together." : "Grade the typed answers." }];
  if (filePart && filePart.text) parts.push({ text: "Extracted answer-sheet text:\n" + filePart.text });
  else if (filePart) parts.unshift(filePart);
  const meter = {};
  const raw = await geminiJson(env, user, { system, contents: [{ role: "user", parts }], kind: "grade", critical: true, meter });
  const graded = {
    score: Number(raw.score) || 0,
    maxScore: Number(raw.maxScore) || 0,
    summary: String(raw.summary || ""),
    questions: Array.isArray(raw.questions) ? raw.questions : [],
  };
  await gh.updateJson(FILES.teacher, [], (rows) => {
    const row = ensureTeacher(rows, user.id);
    row.results = [...(row.results || []), {
      exerciseId: exercise.id,
      subject: exercise.subject,
      topic: exercise.topic,
      score: graded.score,
      max: graded.maxScore,
      at: new Date().toISOString(),
    }].slice(-20);
    row.needsReplan = true;
    return rows;
  });
  return answer({ grade: graded }, meter);
}

function publicExercise(exercise, results = []) {
  return {
    id: exercise.id,
    title: exercise.title,
    subject: exercise.subject,
    topic: exercise.topic,
    difficulty: exercise.difficulty || "medium",
    language: exercise.language,
    createdAt: exercise.createdAt,
    graded: results.some((row) => row.exerciseId === exercise.id),
    questions: exercise.questions.map((question) => {
      if (question.type === "essay") return { id: question.id, type: "essay", prompt: question.prompt };
      return { id: question.id, type: "mcq", prompt: question.prompt, choices: question.choices };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Shapes sent to the browser                                          */
/* ------------------------------------------------------------------ */

function publicProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    username: profile.username,
    name: profile.name || "",
    age: profile.age ?? null,
    grade: profile.grade || "",
    level: profile.level || "",
    examBoard: profile.examBoard || "",
    institution: profile.institution || "",
    course: profile.course || "",
    subjects: profile.subjects || [],
    examDate: profile.examDate || "",
    studyHours: profile.studyHours ?? 2,
    avatarUpdatedAt: profile.avatarUpdatedAt || null,
  };
}

function sanitizeTeacher(teacher) {
  const results = teacher.results || [];
  const updated = teacher.plan?.updatedAt ? Date.parse(teacher.plan.updatedAt) : 0;
  return {
    announcements: teacher.announcements || [],
    learnedTopics: teacher.learnedTopics || [],
    next: teacher.plan?.next || null,
    weakTopics: teacher.plan?.weakTopics || [],
    timetable: teacher.timetable || null,
    vision: teacher.vision || null,
    planUpdatedAt: teacher.plan?.updatedAt || null,
    planStale: !teacher.plan || Boolean(teacher.needsReplan) || Date.now() - updated > 20 * 3600 * 1000,
    exercises: (teacher.exercises || []).map((exercise) => publicExercise(exercise, results)),
    results: results.slice(-8),
  };
}

/* ------------------------------------------------------------------ */
/* Storage helpers                                                     */
/* ------------------------------------------------------------------ */

function notesFile(user) {
  return `notes-${user.id}.json`;
}

async function loadNotes(user, gh) {
  const { data } = await gh.readGitHubFile(notesFile(user), { items: [] });
  return Array.isArray(data?.items) ? data.items : [];
}

async function listMaterials(user, gh) {
  const { data } = await gh.readGitHubFile(FILES.materials, []);
  const bucket = data.find((row) => row.profileId === user.id);
  return bucket?.materials || [];
}

async function loadTeacher(user, gh) {
  const { data } = await gh.readGitHubFile(FILES.teacher, []);
  return data.find((row) => row.profileId === user.id) || {
    profileId: user.id,
    announcements: [],
    learnedTopics: [],
  };
}

function ensureTeacher(rows, profileId) {
  let row = rows.find((item) => item.profileId === profileId);
  if (!row) {
    row = { profileId, announcements: [], learnedTopics: [] };
    rows.push(row);
  }
  return row;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

async function requireUser(request, env, gh) {
  const payload = await tokenPayload(request, env);
  if (!payload?.sub || payload.role === "admin") return null;
  const { data: profiles } = await gh.readGitHubFile(FILES.profiles, []);
  return profiles.find((row) => row.id === payload.sub) || null;
}

async function tokenPayload(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  return verifyToken(token, authSecret(env));
}

function authSecret(env) {
  return env.AUTH_SECRET || env.GITHUB_TOKEN || "";
}

async function hashPassword(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signToken(payload, secret) {
  const body = utf8ToBase64Url(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

async function verifyToken(token, secret) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, base64UrlToBytes(sig), new TextEncoder().encode(body));
  if (!ok) return null;
  try {
    const payload = JSON.parse(base64UrlToUtf8(body));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

async function adminLogin(request, env) {
  if (!env.ADMIN_SECRET) {
    throw new HttpError(503, "Admin is switched off. Add an ADMIN_SECRET secret in Cloudflare to turn it on.");
  }
  if (!authSecret(env)) throw new HttpError(500, "Set AUTH_SECRET first.");
  const body = await readJson(request);
  const given = String(body.secret || "");
  if (!safeEqual(await sha(given), await sha(String(env.ADMIN_SECRET)))) {
    await sleep(400);
    throw new HttpError(401, "That admin secret is wrong.");
  }
  const token = await signToken({ sub: "admin", role: "admin", exp: Date.now() + 12 * 3600 * 1000 }, authSecret(env));
  return json({ token });
}

async function sha(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireAdmin(request, env) {
  const payload = await tokenPayload(request, env);
  if (!payload || payload.role !== "admin") throw new HttpError(401, "Admin login required.");
}

async function handleAdmin(request, env, gh, url) {
  const path = url.pathname;
  const method = request.method;
  if (method === "GET" && path === "/api/admin/monitor") {
    const snapshot = await coordCall(env, "monitor");
    snapshot.persistent = Boolean(env.COORD || env.COORD_LOCAL);
    let names = new Map();
    try {
      const { data: profiles } = await gh.readGitHubFile(FILES.profiles, []);
      names = new Map(profiles.map((row) => [row.id, row.name || row.username]));
      snapshot.users.registered = profiles.length;
    } catch { /* GitHub may not be configured yet */ }
    snapshot.perUser = snapshot.perUser.map((row) => ({ ...row, name: names.get(row.id) || "Student" }));
    snapshot.classes.active_names = snapshot.classes.activeIds.map((id) => names.get(id) || "Student");
    snapshot.classes.queue_names = snapshot.classes.queueIds.map((id) => names.get(id) || "Student");
    delete snapshot.classes.activeIds;
    delete snapshot.classes.queueIds;
    return json(snapshot);
  }
  if (method === "POST" && path === "/api/admin/models") {
    const body = await readJson(request);
    const res = await coordCall(env, "addEntries", {
      label: body.label,
      key: body.key,
      models: body.models,
      rpm: body.rpm,
      rpd: body.rpd,
    });
    return json(res, 201);
  }
  if (method === "PUT" && path === "/api/admin/models") {
    const body = await readJson(request);
    return json(await coordCall(env, "updateEntry", { id: String(body.id || ""), patch: body.patch || {} }));
  }
  if (method === "DELETE" && path === "/api/admin/models") {
    const body = await readJson(request);
    return json(await coordCall(env, "deleteEntry", { id: String(body.id || "") }));
  }
  if (method === "POST" && path === "/api/admin/models/test") {
    const body = await readJson(request);
    return json(await testEntry(env, String(body.id || "")));
  }
  if (method === "PUT" && path === "/api/admin/settings") {
    const body = await readJson(request);
    return json(await coordCall(env, "updateSettings", { patch: body.patch || body }));
  }
  throw new HttpError(404, "No such admin route.");
}

async function testEntry(env, id) {
  const got = await coordCall(env, "reserve", { id });
  if (!got.ok) {
    return { ok: false, message: got.code === "busy" ? "That model is at its per-minute limit. Try again in a moment." : "That model is switched off or out of requests today." };
  }
  const started = Date.now();
  try {
    const text = await callGemini(got.lease, {
      system: "[task:test] Reply with the single word OK.",
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      json: false,
    });
    await coordCall(env, "report", { entryId: got.lease.entryId, outcome: "ok", free: true });
    return { ok: true, ms: Date.now() - started, reply: clip(text, 40) };
  } catch (err) {
    await coordCall(env, "report", {
      entryId: got.lease.entryId,
      outcome: err.rateLimited ? "rate_limit" : "error",
      status: err.status || 0,
      message: err.message,
      free: true,
    }).catch(() => {});
    return { ok: false, message: clip(err.message, 240) };
  }
}

/* ------------------------------------------------------------------ */
/* Coordinator access                                                  */
/* ------------------------------------------------------------------ */

let fallbackCore = null;

function poolSecret(env) {
  return env.POOL_SECRET || env.AUTH_SECRET || env.GITHUB_TOKEN || "";
}

async function coordCall(env, op, args = {}) {
  const payload = {
    ...args,
    env: env.GEMINI_API_KEY ? { key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || DEFAULT_MODEL } : null,
  };
  if (env.COORD) {
    const stub = env.COORD.get(env.COORD.idFromName("main"));
    const res = await stub.fetch("https://coordinator/op", {
      method: "POST",
      body: JSON.stringify({ op, args: payload }),
    });
    const data = await res.json();
    if (!data.ok) throw new HttpError(Number(data.status) || 500, data.error || "Coordinator error");
    return data.result;
  }
  fallbackCore ||= new CoordCore(env.COORD_LOCAL || memoryStorage(), { secret: poolSecret(env) });
  try {
    return await fallbackCore.handle(op, payload);
  } catch (err) {
    throw new HttpError(Number(err.status) || 500, err.message || "Coordinator error");
  }
}

function hoursText(ms) {
  const hours = Math.round(ms / 3600000);
  if (hours <= 0) return "less than an hour";
  return hours === 1 ? "about 1 hour" : `about ${hours} hours`;
}

function busyError(got) {
  const wait = hoursText((got.resetAt || Date.now()) - Date.now());
  if (got.code === "user_quota") {
    return new HttpError(
      429,
      `You have used your ${got.limit} teacher requests for today. They refresh at midnight, Malawi time (${wait} from now). Your timetable and notes are still open.`,
      { code: "user_quota", resetAt: got.resetAt, used: got.used, limit: got.limit },
    );
  }
  if (got.code === "pool_low") {
    return new HttpError(
      503,
      "The teacher is saving the rest of today for classes and exercises. Chat reopens tomorrow — classes still work.",
      { code: "pool_low", resetAt: got.resetAt },
    );
  }
  if (got.code === "pool_exhausted" || got.code === "no_models") {
    return new HttpError(
      503,
      got.code === "no_models"
        ? "No AI model is set up yet. The admin needs to add a Google AI Studio key."
        : `The teacher has helped a lot of students today and needs a rest. Lessons reopen tomorrow (${wait} from now).`,
      { code: got.code, resetAt: got.resetAt },
    );
  }
  return new HttpError(
    503,
    "The teacher is busy with other students right now. Try again in a few seconds.",
    { code: "busy", retryAfterMs: got.retryAfterMs || 5000 },
  );
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function geminiError(status, text) {
  const err = new Error(`Gemini ${status}: ${clip(String(text).replace(/\s+/g, " "), 240)}`);
  err.status = status;
  err.rateLimited = status === 429 || /RESOURCE_EXHAUSTED/i.test(text);
  err.retryable = err.rateLimited || status >= 500 || [401, 403, 404].includes(status)
    || (status === 400 && /API key|API_KEY_INVALID/i.test(text));
  return err;
}

/** One request to Google with a lease (key + model) handed out by the coordinator. */
async function callGemini(lease, { system, contents, json: asJson }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(lease.model)}:generateContent`;
  const payload = (forceJson) => JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      maxOutputTokens: 8192,
      ...(forceJson ? { responseMimeType: "application/json" } : {}),
    },
  });
  const headers = {
    "content-type": "application/json",
    "x-goog-api-key": lease.key,
  };
  let res = await fetch(url, { method: "POST", headers, body: payload(Boolean(asJson)) });
  if (!res.ok && asJson && res.status === 400) {
    const errText = await res.text();
    if (/API key|API_KEY_INVALID/i.test(errText)) throw geminiError(400, errText);
    res = await fetch(url, { method: "POST", headers, body: payload(false) });
    if (!res.ok) throw geminiError(res.status, await res.text());
  } else if (!res.ok) {
    throw geminiError(res.status, await res.text());
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((part) => !part.thought).map((part) => part.text || "").join("").trim();
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "empty";
    const err = new Error(`Gemini returned no text (${reason}).`);
    err.status = 502;
    throw err;
  }
  return text;
}

/**
 * Every AI request goes through here: the coordinator checks the student's daily limit,
 * picks the least busy key/model, and is told how the call went.
 */
async function gemini(env, user, { system, contents, json: asJson = false, kind = "chat", critical = false, free = false, meter }) {
  const userId = user?.id || "system";
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const got = await coordCall(env, "acquire", { userId, kind, critical, free });
    if (!got.ok) {
      if (got.code === "busy" && (got.retryAfterMs || 0) <= 6000 && attempt < 3) {
        await sleep((got.retryAfterMs || 500) + 40);
        continue;
      }
      throw busyError(got);
    }
    if (meter && !free) meter.quota = got.quota;
    const lease = got.lease;
    try {
      const text = await callGemini(lease, { system, contents, json: asJson });
      await coordCall(env, "report", { userId, entryId: lease.entryId, outcome: "ok" }).catch(() => {});
      return text;
    } catch (err) {
      await coordCall(env, "report", {
        userId,
        entryId: lease.entryId,
        outcome: err.rateLimited ? "rate_limit" : "error",
        status: err.status || 0,
        message: err.message,
        free: lease.free,
      }).catch(() => {});
      lastErr = err;
      if (!err.retryable) break;
    }
  }
  if (lastErr?.rateLimited || lastErr?.retryable) {
    throw new HttpError(503, "The teacher is busy with other students right now. Try again in a few seconds.", { code: "busy", retryAfterMs: 8000 });
  }
  throw new HttpError(502, "The teacher could not answer that. " + clip(lastErr?.message || "", 200));
}

async function geminiJson(env, user, args) {
  const text = await gemini(env, user, { ...args, json: true });
  try {
    return parseJsonLoose(text);
  } catch {
    const fixed = await gemini(env, user, {
      system: "[task:repair]\nReturn only the repaired JSON object. No markdown.",
      contents: [{ role: "user", parts: [{ text: text.slice(0, 20000) }] }],
      json: true,
      kind: "repair",
      free: true,
    });
    try {
      return parseJsonLoose(fixed);
    } catch {
      throw new HttpError(502, "The teacher's answer was garbled. Try again.");
    }
  }
}

function parseJsonLoose(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no json");
  return JSON.parse(source.slice(start, end + 1));
}

function toContents(history, message) {
  const merged = [];
  for (const turn of history.slice(-12)) {
    const role = turn.role === "assistant" || turn.role === "model" ? "model" : "user";
    const text = clip(String(turn.content || turn.text || "").trim(), 8000);
    if (!text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === role) prev.parts[0].text += "\n" + text;
    else merged.push({ role, parts: [{ text }] });
  }
  if (merged[0]?.role === "model") merged.shift();
  const text = clip(message, 8000);
  const prev = merged[merged.length - 1];
  if (prev && prev.role === "user") prev.parts[0].text += "\n" + text;
  else merged.push({ role: "user", parts: [{ text }] });
  return merged;
}

/* ------------------------------------------------------------------ */
/* Cleaning and file helpers                                           */
/* ------------------------------------------------------------------ */

function cleanUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,24}$/.test(username)) {
    throw new HttpError(400, "Username must be 3–24 characters: letters, numbers, dots, dashes.");
  }
  return username;
}

function cleanAge(value) {
  if (value === "" || value === null || value === undefined) return null;
  const age = Number(value);
  if (!Number.isFinite(age) || age < 8 || age > 100) throw new HttpError(400, "Age should be between 8 and 100.");
  return Math.round(age);
}

function cleanLevel(value) {
  const level = String(value || "").trim();
  if (!level) return "";
  if (!LEVELS.includes(level)) throw new HttpError(400, "Choose a level from the list.");
  return level;
}

function cleanSubjects(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map((item) => clip(String(item).trim(), 40)).filter(Boolean))].slice(0, 12);
}

function cleanDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new HttpError(400, "Exam date must be YYYY-MM-DD.");
  return text;
}

function cleanHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours)) return 2;
  return Math.min(12, Math.max(0.5, Math.round(hours * 2) / 2));
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "That request was not valid JSON.");
  }
}

function clip(text, max) {
  const value = String(text ?? "");
  return value.length > max ? value.slice(0, max) : value;
}

function guessMime(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

async function fileToGeminiPart(name, mime, bytes) {
  const lower = name.toLowerCase();
  if (mime.includes("wordprocessingml") || lower.endsWith(".docx")) {
    const xml = await extractZipTextFile(bytes, "word/document.xml");
    const text = docxXmlToText(xml).slice(0, 60000);
    if (!text) throw new HttpError(400, "Could not read that DOCX. Export it as PDF and upload again.");
    return { text };
  }
  if (mime.startsWith("text/") || lower.endsWith(".txt") || lower.endsWith(".md")) {
    return { text: new TextDecoder().decode(bytes).slice(0, 60000) };
  }
  const allowed = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
  if (!allowed.includes(mime)) {
    throw new HttpError(400, "Upload a PDF, DOCX, text file, or image.");
  }
  return { inlineData: { mimeType: mime, data: bytesToBase64(bytes) } };
}

async function extractZipTextFile(buf, wanted) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    if (flags & 0x08 && compSize === 0) {
      throw new HttpError(400, "That DOCX uses a zip layout this app cannot read. Export as PDF.");
    }
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) break;
    if (name.replace(/\\/g, "/") === wanted) {
      const slice = bytes.subarray(dataStart, dataEnd);
      if (method === 0) return new TextDecoder().decode(slice);
      if (method === 8) {
        const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        const xml = new Uint8Array(await new Response(stream).arrayBuffer());
        return new TextDecoder().decode(xml);
      }
      throw new HttpError(400, "That DOCX is compressed in an unsupported way. Export as PDF.");
    }
    offset = dataEnd;
  }
  return "";
}

function docxXmlToText(xml) {
  return String(xml || "").split(/<\/w:p>/).map((block) => {
    const bits = [];
    const re = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let match;
    while ((match = re.exec(block))) bits.push(decodeXml(match[1]));
    return bits.join("");
  }).filter(Boolean).join("\n");
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/* ------------------------------------------------------------------ */
/* GitHub JSON store                                                   */
/* ------------------------------------------------------------------ */

function createGithub(env) {
  const owner = (env.GITHUB_OWNER || "").trim();
  const repo = (env.GITHUB_REPO || "aidata").trim();
  const branch = (env.GITHUB_BRANCH || "main").trim();
  const queues = new Map();
  const cache = new Map();

  function headers() {
    return {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "study-helper",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  function fileUrl(path) {
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}`;
  }

  async function readGitHubFile(path, fallback) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < 2500) {
      return { data: structuredClone(hit.data), sha: hit.sha };
    }
    const res = await fetch(`${fileUrl(path)}?ref=${encodeURIComponent(branch)}`, { headers: headers() });
    if (res.status === 404) return { data: structuredClone(fallback), sha: null };
    if (!res.ok) throw new HttpError(502, "GitHub read failed. " + clip(await res.text(), 240));
    const payload = await res.json();
    let text = "";
    if (payload.content) text = base64ToUtf8(payload.content);
    else if (payload.download_url) {
      const raw = await fetch(payload.download_url, { headers: headers() });
      if (!raw.ok) throw new HttpError(502, "GitHub download failed.");
      text = await raw.text();
    }
    const data = text ? JSON.parse(text) : structuredClone(fallback);
    cache.set(path, { at: Date.now(), sha: payload.sha || null, data: structuredClone(data) });
    return { data: structuredClone(data), sha: payload.sha || null };
  }

  async function writeGitHubFile(path, data, sha) {
    const body = {
      message: `Update ${path}`,
      content: utf8ToBase64(JSON.stringify(data, null, 2)),
      branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(fileUrl(path), {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 422) {
      throw new HttpError(409, "GitHub file changed while saving.");
    }
    if (!res.ok) throw new HttpError(502, "GitHub write failed. " + clip(await res.text(), 240));
    const payload = await res.json();
    const nextSha = payload.content?.sha || payload.commit?.sha || null;
    cache.set(path, { at: Date.now(), sha: nextSha, data: structuredClone(data) });
    return nextSha;
  }

  function enqueue(path, fn) {
    const prev = queues.get(path) || Promise.resolve();
    const run = prev.then(fn, fn);
    queues.set(path, run.then(() => {}, () => {}));
    return run;
  }

  async function updateJson(path, fallback, mutator) {
    return enqueue(path, async () => {
      let last = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const { data, sha } = await readGitHubFile(path, fallback);
        const next = await mutator(data);
        try {
          await writeGitHubFile(path, next, sha);
          return next;
        } catch (err) {
          last = err;
          cache.delete(path);
          if (err.status !== 409) throw err;
        }
      }
      throw last || new HttpError(409, "GitHub is busy. Try again.");
    });
  }

  return { readGitHubFile, writeGitHubFile, updateJson };
}

function utf8ToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function utf8ToBase64Url(text) {
  return bytesToBase64(new TextEncoder().encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToUtf8(b64) {
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return base64ToUtf8(b64.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

function base64UrlToBytes(b64) {
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
