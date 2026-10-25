/**
 * Study Helper — Cloudflare Worker.
 * Vanilla frontend is served through the ASSETS binding.
 * JSON lives in a GitHub repo. Gemini model: gemini-3.5-flash-lite.
 * No Node, fs, or Express. Temperature / topP / topK are omitted on purpose:
 * Gemini 3.5 Flash-Lite rejects those sampling fields.
 */

const FILES = {
  profiles: "profiles.json",
  materials: "materials.json",
  teacher: "teacher-states.json",
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
      const message = err instanceof HttpError ? err.message : "Something went wrong. " + (err.message || "Unknown error");
      return json({ error: message }, status, cors);
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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function handleApi(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;
  const gh = createGithub(env);

  if (method === "GET" && path === "/api/setup") {
    return json(setupStatus(env));
  }
  if (method === "POST" && path === "/api/auth/register") {
    return register(request, env, gh);
  }
  if (method === "POST" && path === "/api/auth/login") {
    return login(request, env, gh);
  }

  const user = await requireUser(request, env, gh);
  if (!user) throw new HttpError(401, "Log in again.");

  if (method === "GET" && path === "/api/bootstrap") return bootstrap(user, gh);
  if (method === "GET" && path === "/api/profile") return json({ profile: publicProfile(user) });
  if (method === "PUT" && path === "/api/profile") return updateProfile(request, user, gh);
  if (method === "POST" && path === "/api/chat") return chat(request, env, user, gh);
  if (method === "GET" && path === "/api/materials") return json({ materials: await listMaterials(user, gh) });
  if (method === "POST" && path === "/api/materials/upload") return uploadMaterial(request, env, user, gh);
  if (method === "DELETE" && path === "/api/materials") return deleteMaterial(request, user, gh);
  if (method === "POST" && path === "/api/classroom/suggest") return suggestClass(env, ctx, user, gh);
  if (method === "POST" && path === "/api/classroom/start") return startClass(request, env, ctx, user, gh);
  if (method === "POST" && path === "/api/classroom/ask") return askClass(request, env, user, gh);
  if (method === "POST" && path === "/api/classroom/complete") return completeClass(request, ctx, user, gh);
  if (method === "POST" && path === "/api/timetable/generate") return generateTimetable(request, env, ctx, user, gh);
  if (method === "POST" && path === "/api/exercises/generate") return generateExercises(request, env, user, gh);
  if (method === "POST" && path === "/api/exercises/grade") return gradeExercises(request, env, user, gh);
  if (method === "POST" && path === "/api/vision/refresh") return refreshVision(env, ctx, user, gh);

  throw new HttpError(404, "No such API route.");
}

function setupStatus(env) {
  const owner = (env.GITHUB_OWNER || "").trim();
  const repo = (env.GITHUB_REPO || "aidata").trim();
  const ownerOk = Boolean(owner) && owner !== "your-github-username";
  const gemini = Boolean(env.GEMINI_API_KEY);
  const github = Boolean(env.GITHUB_TOKEN) && ownerOk;
  return {
    ok: gemini && github && Boolean(authSecret(env)),
    gemini,
    github,
    repo: ownerOk ? `${owner}/${repo}` : "",
    model: env.GEMINI_MODEL || "gemini-3.5-flash-lite",
  };
}

function assertStorage(env) {
  const status = setupStatus(env);
  if (!env.GITHUB_TOKEN || !status.github) {
    throw new HttpError(500, "Set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO before accounts can be saved.");
  }
  if (!authSecret(env)) {
    throw new HttpError(500, "Set AUTH_SECRET (wrangler secret put AUTH_SECRET).");
  }
}

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
    name: clip(String(body.name || "").trim(), 80),
    age: cleanAge(body.age),
    grade: clip(String(body.grade || "").trim(), 40),
    subjects: cleanSubjects(body.subjects),
    examDate: cleanDate(body.examDate),
    studyHours: cleanHours(body.studyHours),
    avatarUpdatedAt: new Date().toISOString(),
  };
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
    if (!rows.some((row) => row.profileId === profile.id)) {
      rows.push({ profileId: profile.id, announcements: [], learnedTopics: [], pendingClassSuggestion: null });
    }
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

async function updateProfile(request, user, gh) {
  const body = await readJson(request);
  let saved = null;
  await gh.updateJson(FILES.profiles, [], (rows) => {
    const row = rows.find((item) => item.id === user.id);
    if (!row) throw new HttpError(404, "Profile not found.");
    if (body.name !== undefined) row.name = clip(String(body.name || "").trim(), 80);
    if (body.age !== undefined) row.age = cleanAge(body.age);
    if (body.grade !== undefined) row.grade = clip(String(body.grade || "").trim(), 40);
    if (body.subjects !== undefined) row.subjects = cleanSubjects(body.subjects);
    if (body.examDate !== undefined) row.examDate = cleanDate(body.examDate);
    if (body.studyHours !== undefined) row.studyHours = cleanHours(body.studyHours);
    row.avatarUpdatedAt = new Date().toISOString();
    saved = row;
    return rows;
  });
  return json({ profile: publicProfile(saved) });
}

async function bootstrap(user, gh) {
  const materials = await listMaterials(user, gh);
  const teacher = sanitizeTeacher(await loadTeacher(user, gh));
  return json({ profile: publicProfile(user), materials, teacher });
}

async function chat(request, env, user, gh) {
  const body = await readJson(request);
  const message = clip(String(body.message || "").trim(), 8000);
  if (!message) throw new HttpError(400, "Type a message first.");
  const language = body.language === "ny" ? "ny" : "en";
  const materials = await listMaterials(user, gh);
  const system = [
    "[task:chat]",
    "You are Study Helper, a warm secondary-school tutor. Teach step by step.",
    "Give one move at a time. When the student is stuck, hint before you explain.",
    "Use short markdown: paragraphs, a list when it helps, and fenced math only if needed.",
    "Do not open with 'Certainly' or a label like 'Tutor:'.",
    language === "ny"
      ? "The student asked for Chichewa. Reply in natural Chichewa (Chinyanja) that a secondary student in Malawi can follow. Keep formulas and unavoidable English terms, then explain them in Chichewa."
      : "Reply in clear English unless the student writes in another language — then match them.",
    profileBlurb(user),
    syllabusBlurb(materials),
  ].join("\n\n");
  const contents = toContents(Array.isArray(body.history) ? body.history : [], message);
  const reply = await gemini(env, { system, contents, json: false });
  return json({ reply });
}

async function uploadMaterial(request, env, user, gh) {
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") throw new HttpError(400, "Choose a PDF, DOCX, text file, or image.");
  const name = clip(String(file.name || "notes").trim(), 120);
  const size = file.size || 0;
  if (size <= 0) throw new HttpError(400, "That file is empty.");
  if (size > 8_000_000) throw new HttpError(413, "Keep uploads under 8 MB.");
  const subjectHint = clip(String(form.get("subject") || "").trim(), 60);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || guessMime(name);
  const part = await fileToGeminiPart(name, mime, bytes);
  const system = [
    "[task:extract]",
    "Extract a study outline from this student material.",
    "Return JSON only: {\"subject\":\"\",\"topics\":[{\"name\":\"\",\"subtopics\":[\"\"]}]}.",
    "Use 3 to 8 topics. Subtopics are short noun phrases. Do not invent chapters that are not in the file.",
    subjectHint ? `The student says the subject is ${subjectHint}. Use it unless the file clearly disagrees.` : "Choose the most likely school subject.",
  ].join("\n");
  const contents = [{ role: "user", parts: [part, { text: "Extract the topics and subtopics." }] }];
  const raw = await geminiJson(env, { system, contents });
  const topics = Array.isArray(raw.topics)
    ? raw.topics.slice(0, 12).map((topic) => ({
        name: clip(String(topic.name || "Topic").trim(), 80),
        subtopics: Array.isArray(topic.subtopics)
          ? topic.subtopics.slice(0, 8).map((item) => clip(String(item).trim(), 80)).filter(Boolean)
          : [],
      })).filter((topic) => topic.name)
    : [];
  if (!topics.length) throw new HttpError(422, "No topics could be read from that file. Try a text-based PDF.");
  const material = {
    id: crypto.randomUUID(),
    name,
    subject: clip(String(raw.subject || subjectHint || "General").trim(), 60),
    topics,
    addedAt: new Date().toISOString(),
  };
  await gh.updateJson(FILES.materials, [], (rows) => {
    let bucket = rows.find((row) => row.profileId === user.id);
    if (!bucket) {
      bucket = { profileId: user.id, materials: [] };
      rows.push(bucket);
    }
    bucket.materials.push(material);
    return rows;
  });
  return json({ material }, 201);
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
  return json({ ok: true });
}

async function suggestClass(env, ctx, user, gh) {
  const materials = await listMaterials(user, gh);
  const teacher = await loadTeacher(user, gh);
  const system = [
    "[task:suggest]",
    "Pick the single best next 15-minute lesson for this student.",
    "Return JSON only: {\"subject\":\"\",\"topic\":\"\",\"reason\":\"\"}.",
    "Prefer a syllabus gap they have not learned. Topic is specific, not a whole subject.",
    profileBlurb(user),
    syllabusBlurb(materials),
    "Already learned: " + ((teacher.learnedTopics || []).join("; ") || "nothing yet"),
  ].join("\n\n");
  const raw = await geminiJson(env, {
    system,
    contents: [{ role: "user", parts: [{ text: "Suggest the next class." }] }],
  });
  const suggestion = {
    subject: clip(String(raw.subject || user.subjects?.[0] || "General").trim(), 60),
    topic: clip(String(raw.topic || "Review").trim(), 120),
    reason: clip(String(raw.reason || "").trim(), 240),
  };
  saveSoon(ctx, rememberSuggestion(gh, user.id, suggestion));
  return json({ suggestion });
}

async function startClass(request, env, ctx, user, gh) {
  const body = await readJson(request);
  const language = body.language === "ny" ? "ny" : "en";
  const subject = clip(String(body.subject || user.subjects?.[0] || "General").trim(), 60);
  const topic = clip(String(body.topic || "").trim(), 140);
  if (!topic) throw new HttpError(400, "Name the topic for this class.");
  const materials = await listMaterials(user, gh);
  const teacher = await loadTeacher(user, gh);
  const langLine = language === "ny"
    ? "Write EVERY text field and EVERY speech field in Chichewa (Chinyanja) for a Malawian secondary student. Keep numerals, symbols, and names of diagrams. Speech is what the teacher says aloud, one or two spoken sentences, no markdown."
    : "Write EVERY text field and EVERY speech field in spoken-style English. Speech is one or two sentences the teacher says aloud, no markdown.";
  const system = [
    "[task:lesson]",
    "You write a 15-minute chalkboard lesson with 10 to 15 segments.",
    langLine,
    "Return JSON only with this shape:",
    '{"subject":"","topic":"","layout":"single|two|three","segments":[{"kind":"title|point|break","section":1,"elements":[{"type":"title","text":""},{"type":"text","text":""},{"type":"draw","shape":"circle|cycle|venn|ruler|protractor","nodes":[{"label":""}]}],"speech":""}]}',
    "Rules: layout is single, two, or three. kind cycles through title, then points, with a break around the middle.",
    "Most segments have 1 to 3 elements. Use at least 4 draw elements across the lesson, only the shapes listed.",
    "nodes are labels for the drawing. A ruler or protractor can use measurement labels. A cycle uses 3 to 5 steps. A venn uses 2 or 3 set names.",
    "Teach this exact topic. Do not swap subjects. Build ideas in order. The last segment is a short check question in the speech.",
    profileBlurb(user),
    syllabusBlurb(materials),
    "Already learned: " + ((teacher.learnedTopics || []).slice(-12).join("; ") || "nothing yet"),
  ].join("\n\n");
  const raw = await geminiJson(env, {
    system,
    contents: [{ role: "user", parts: [{ text: `Subject: ${subject}\nTopic: ${topic}\nLanguage: ${language}` }] }],
  });
  const lesson = normalizeLesson(raw, { subject, topic, language });
  if (lesson.segments.length < 4) throw new HttpError(502, "The lesson came back too short. Start the class again.");
  saveSoon(ctx, rememberSuggestion(gh, user.id, { subject: lesson.subject, topic: lesson.topic, reason: "In class now" }));
  return json({ lesson });
}

async function askClass(request, env, user, gh) {
  const body = await readJson(request);
  const question = clip(String(body.question || "").trim(), 2000);
  if (!question) throw new HttpError(400, "Ask a question first.");
  const language = body.language === "ny" ? "ny" : "en";
  const system = [
    "[task:ask]",
    "A student raised their hand in a live chalkboard class. Answer in a short, kind way, then point them back to the lesson.",
    "Return JSON only: {\"answer\":\"markdown\",\"speech\":\"one or two sentences to read aloud\"}.",
    language === "ny" ? "answer and speech must be Chichewa (Chinyanja)." : "answer and speech must be English unless the student asked in another language.",
    profileBlurb(user),
    `Subject: ${clip(String(body.subject || ""), 60)}`,
    `Topic: ${clip(String(body.topic || ""), 140)}`,
    `What was just on the board: ${clip(String(body.recent || ""), 1500)}`,
  ].join("\n");
  const raw = await geminiJson(env, {
    system,
    contents: [{ role: "user", parts: [{ text: question }] }],
  });
  return json({
    answer: String(raw.answer || "Let's look at that together."),
    speech: String(raw.speech || raw.answer || ""),
  });
}

async function completeClass(request, ctx, user, gh) {
  const body = await readJson(request);
  const topic = clip(String(body.topic || "").trim(), 140);
  const subject = clip(String(body.subject || "").trim(), 60);
  if (!topic) return json({ ok: true });
  const label = subject ? `${subject}: ${topic}` : topic;
  saveSoon(ctx, gh.updateJson(FILES.teacher, [], (rows) => {
    const row = ensureTeacher(rows, user.id);
    const learned = new Set(row.learnedTopics || []);
    learned.add(label);
    row.learnedTopics = [...learned].slice(-40);
    row.pendingClassSuggestion = null;
    return rows;
  }));
  return json({ ok: true, learned: label });
}

async function generateTimetable(request, env, ctx, user, gh) {
  const body = await readJson(request);
  const language = body.language === "ny" ? "ny" : "en";
  const materials = await listMaterials(user, gh);
  const teacher = await loadTeacher(user, gh);
  const hours = cleanHours(user.studyHours);
  const system = [
    "[task:timetable]",
    `Build a 7-day study timetable. The student can work about ${hours} hours on a study day.`,
    "Use six study days and one lighter day. Tasks are concrete (a topic, not just the subject name).",
    "Return JSON only: {\"summary\":\"\",\"days\":[{\"day\":\"Monday\",\"blocks\":[{\"start\":\"16:00\",\"end\":\"17:00\",\"subject\":\"\",\"task\":\"\"}]}]}",
    "Days must be Monday through Sunday. Times are 24-hour HH:MM. Keep blocks between 25 and 90 minutes.",
    language === "ny" ? "Write summary and task in Chichewa." : "Write summary and task in English.",
    profileBlurb(user),
    syllabusBlurb(materials),
    "Already learned: " + ((teacher.learnedTopics || []).slice(-12).join("; ") || "nothing yet"),
    user.examDate ? `Exam date: ${user.examDate}. Put more time on exam topics as the date gets closer.` : "No exam date set.",
  ].join("\n\n");
  const raw = await geminiJson(env, {
    system,
    contents: [{ role: "user", parts: [{ text: "Generate this week's timetable." }] }],
  });
  const timetable = normalizeTimetable(raw);
  saveSoon(ctx, gh.updateJson(FILES.teacher, [], (rows) => {
    const row = ensureTeacher(rows, user.id);
    row.timetable = timetable;
    return rows;
  }));
  return json({ timetable });
}

async function generateExercises(request, env, user, gh) {
  const body = await readJson(request);
  const language = body.language === "ny" ? "ny" : "en";
  const subject = clip(String(body.subject || user.subjects?.[0] || "General").trim(), 60);
  const topic = clip(String(body.topic || "").trim(), 140);
  if (!topic) throw new HttpError(400, "Name a topic for the exercise.");
  const system = [
    "[task:exercise]",
    "Write a short mixed exercise: 4 multiple-choice questions and 2 essay questions.",
    "Return JSON only:",
    '{"title":"","questions":[{"id":"q1","type":"mcq","prompt":"","choices":["","","",""],"answer":"","explanation":""},{"id":"q5","type":"essay","prompt":"","modelPoints":[""]}]}',
    "MCQ answer must be the exact choice text, not a letter. Exactly 4 choices. One correct choice.",
    "Essay modelPoints are the facts a strong answer includes. Do not reveal them in the prompt.",
    language === "ny" ? "Write prompts, choices, and explanations in Chichewa." : "Write prompts and choices in English.",
    profileBlurb(user),
    `Subject: ${subject}. Topic: ${topic}. Match grade ${user.grade || "secondary"}.`,
  ].join("\n\n");
  const raw = await geminiJson(env, {
    system,
    contents: [{ role: "user", parts: [{ text: "Write the exercise." }] }],
  });
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).slice(0, 8).map((item, index) => {
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
  const exercise = {
    id: crypto.randomUUID(),
    title: clip(String(raw.title || topic).trim(), 120),
    subject,
    topic,
    language,
    createdAt: new Date().toISOString(),
    questions,
  };
  await gh.updateJson(FILES.teacher, [], (rows) => {
    const row = ensureTeacher(rows, user.id);
    row.exercises = [...(row.exercises || []), exercise].slice(-8);
    return rows;
  });
  return json({ exercise: publicExercise(exercise) }, 201);
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
      if (file.size > 8_000_000) throw new HttpError(413, "Keep the answer sheet under 8 MB.");
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
  if (!exercise) throw new HttpError(404, "That exercise is not on file. Generate it again.");
  const system = [
    "[task:grade]",
    "Grade the student fairly against the answer key. Partial credit is allowed on essays.",
    "Return JSON only: {\"score\":0,\"maxScore\":0,\"summary\":\"\",\"questions\":[{\"id\":\"q1\",\"score\":0,\"max\":1,\"feedback\":\"\"}]}",
    "maxScore is the total of question max values. MCQ max is 1. Essay max is 3.",
    exercise.language === "ny" ? "Write summary and feedback in Chichewa." : "Write summary and feedback in English.",
    "Answer key JSON:\n" + JSON.stringify(exercise.questions),
    "Student typed answers JSON:\n" + JSON.stringify(answers).slice(0, 12000),
  ].join("\n\n");
  const parts = [{ text: filePart ? "Grade the typed answers and the uploaded answer sheet together." : "Grade the typed answers." }];
  if (filePart && filePart.text) parts.push({ text: "Extracted answer-sheet text:\n" + filePart.text });
  else if (filePart) parts.unshift(filePart);
  const raw = await geminiJson(env, { system, contents: [{ role: "user", parts }] });
  const graded = {
    score: Number(raw.score) || 0,
    maxScore: Number(raw.maxScore) || 0,
    summary: String(raw.summary || ""),
    questions: Array.isArray(raw.questions) ? raw.questions : [],
  };
  return json({ grade: graded });
}

async function refreshVision(env, ctx, user, gh) {
  const materials = await listMaterials(user, gh);
  const teacher = await loadTeacher(user, gh);
  const system = [
    "[task:vision]",
    "Write a short study vision for this student: where they are headed before the exam, and two practical announcements.",
    "Return JSON only: {\"statement\":\"2 or 3 sentences\",\"announcements\":[\"\",\"\"],\"nextTopic\":\"\",\"nextSubject\":\"\"}",
    profileBlurb(user),
    syllabusBlurb(materials),
    "Already learned: " + ((teacher.learnedTopics || []).slice(-12).join("; ") || "nothing yet"),
  ].join("\n\n");
  const raw = await geminiJson(env, {
    system,
    contents: [{ role: "user", parts: [{ text: "Write the vision." }] }],
  });
  const vision = {
    statement: clip(String(raw.statement || "").trim(), 600),
    nextTopic: clip(String(raw.nextTopic || "").trim(), 140),
    nextSubject: clip(String(raw.nextSubject || "").trim(), 60),
    updatedAt: new Date().toISOString(),
  };
  const announcements = (Array.isArray(raw.announcements) ? raw.announcements : [])
    .slice(0, 4)
    .map((text) => ({ id: crypto.randomUUID(), text: clip(String(text).trim(), 220), at: vision.updatedAt }))
    .filter((item) => item.text);
  saveSoon(ctx, gh.updateJson(FILES.teacher, [], (rows) => {
    const row = ensureTeacher(rows, user.id);
    row.vision = vision;
    if (announcements.length) row.announcements = announcements;
    if (vision.nextTopic) {
      row.pendingClassSuggestion = {
        topic: vision.nextTopic,
        subject: vision.nextSubject,
        scheduledAt: new Date().toISOString(),
      };
    }
    return rows;
  }));
  return json({ vision, announcements });
}

function normalizeLesson(raw, fallback) {
  const layouts = new Set(["single", "two", "three"]);
  const kinds = new Set(["title", "point", "break"]);
  const shapes = new Set(["circle", "cycle", "venn", "ruler", "protractor"]);
  const segments = (Array.isArray(raw.segments) ? raw.segments : []).slice(0, 15).map((segment) => {
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
    segments,
  };
}

function normalizeTimetable(raw) {
  const order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const days = (Array.isArray(raw.days) ? raw.days : []).slice(0, 7).map((day, index) => ({
    day: clip(String(day.day || order[index] || "Day"), 20),
    blocks: (Array.isArray(day.blocks) ? day.blocks : []).slice(0, 6).map((block) => ({
      start: clip(String(block.start || ""), 8),
      end: clip(String(block.end || ""), 8),
      subject: clip(String(block.subject || ""), 40),
      task: clip(String(block.task || ""), 160),
    })).filter((block) => block.task),
  }));
  return { summary: clip(String(raw.summary || "").trim(), 400), days };
}

function publicExercise(exercise) {
  return {
    id: exercise.id,
    title: exercise.title,
    subject: exercise.subject,
    topic: exercise.topic,
    language: exercise.language,
    createdAt: exercise.createdAt,
    questions: exercise.questions.map((question) => {
      if (question.type === "essay") return { id: question.id, type: "essay", prompt: question.prompt };
      return { id: question.id, type: "mcq", prompt: question.prompt, choices: question.choices };
    }),
  };
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    username: profile.username,
    name: profile.name || "",
    age: profile.age ?? null,
    grade: profile.grade || "",
    subjects: profile.subjects || [],
    examDate: profile.examDate || "",
    studyHours: profile.studyHours ?? 2,
    avatarUpdatedAt: profile.avatarUpdatedAt || null,
  };
}

function profileBlurb(user) {
  const p = publicProfile(user);
  return [
    `Student: ${p.name || p.username}`,
    p.age ? `Age: ${p.age}` : "",
    p.grade ? `Grade: ${p.grade}` : "",
    p.subjects?.length ? `Subjects: ${p.subjects.join(", ")}` : "",
    p.examDate ? `Exam date: ${p.examDate}` : "",
    `Study hours a day: ${p.studyHours}`,
  ].filter(Boolean).join("\n");
}

function syllabusBlurb(materials) {
  if (!materials.length) return "No uploaded materials yet.";
  return "Materials:\n" + materials.map((material) => {
    const topics = (material.topics || []).map((topic) => {
      const subs = (topic.subtopics || []).slice(0, 4).join(", ");
      return subs ? `${topic.name} (${subs})` : topic.name;
    }).join("; ");
    return `- ${material.subject}: ${material.name} — ${topics}`;
  }).join("\n");
}

function sanitizeTeacher(teacher) {
  return {
    announcements: teacher.announcements || [],
    learnedTopics: teacher.learnedTopics || [],
    pendingClassSuggestion: teacher.pendingClassSuggestion || null,
    timetable: teacher.timetable || null,
    vision: teacher.vision || null,
    exercises: (teacher.exercises || []).map(publicExercise),
  };
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
    pendingClassSuggestion: null,
  };
}

function ensureTeacher(rows, profileId) {
  let row = rows.find((item) => item.profileId === profileId);
  if (!row) {
    row = { profileId, announcements: [], learnedTopics: [], pendingClassSuggestion: null };
    rows.push(row);
  }
  return row;
}

function rememberSuggestion(gh, profileId, suggestion) {
  return gh.updateJson(FILES.teacher, [], (rows) => {
    const row = ensureTeacher(rows, profileId);
    row.pendingClassSuggestion = {
      topic: suggestion.topic,
      subject: suggestion.subject || "",
      scheduledAt: new Date().toISOString(),
    };
    return rows;
  });
}

function saveSoon(ctx, promise) {
  const tracked = Promise.resolve(promise).catch((err) => console.error("background save failed", err.message || err));
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(tracked);
  return tracked;
}

async function requireUser(request, env, gh) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const payload = await verifyToken(token, authSecret(env));
  if (!payload?.sub) return null;
  const { data: profiles } = await gh.readGitHubFile(FILES.profiles, []);
  return profiles.find((row) => row.id === payload.sub) || null;
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
  const value = String(text || "");
  return value.length > max ? value.slice(0, max) : value;
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

async function gemini(env, { system, contents, json: asJson }) {
  if (!env.GEMINI_API_KEY) {
    throw new HttpError(500, "Set GEMINI_API_KEY before using the tutor.");
  }
  const model = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
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
    "x-goog-api-key": env.GEMINI_API_KEY,
  };
  let res = await fetch(url, { method: "POST", headers, body: payload(Boolean(asJson)) });
  if (!res.ok && asJson && res.status === 400) {
    const errText = await res.text();
    res = await fetch(url, { method: "POST", headers, body: payload(false) });
    if (!res.ok) throw new HttpError(502, "Gemini rejected the request. " + clip(errText, 280));
  } else if (!res.ok) {
    throw new HttpError(502, "Gemini request failed. " + clip(await res.text(), 280));
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((part) => !part.thought).map((part) => part.text || "").join("").trim();
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "empty";
    throw new HttpError(502, `Gemini returned no text (${reason}).`);
  }
  return text;
}

async function geminiJson(env, args) {
  const text = await gemini(env, { ...args, json: true });
  try {
    return parseJsonLoose(text);
  } catch {
    const fixed = await gemini(env, {
      system: "[task:repair]\nReturn only the repaired JSON object. No markdown.",
      contents: [{ role: "user", parts: [{ text: text.slice(0, 20000) }] }],
      json: true,
    });
    return parseJsonLoose(fixed);
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
    let compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    let dataStart = nameStart + nameLen + extraLen;
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
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, "\"")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

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
    if (res.status === 409) {
      const error = new HttpError(409, "GitHub file changed while saving.");
      throw error;
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
