import assert from "node:assert/strict";
import zlib from "node:zlib";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const files = new Map();
let shaN = 0;
let lastPrompt = "";
const calls = [];

function zipDocx(xml) {
  const raw = Buffer.from(xml);
  const data = zlib.deflateRawSync(raw);
  const name = Buffer.from("word/document.xml");
  const local = Buffer.alloc(30 + name.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  data.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  if (target.hostname === "api.github.com") {
    const match = target.pathname.match(/\/contents\/(.+)$/);
    const path = decodeURIComponent(match[1]);
    if ((init.method || "GET") === "PUT") {
      const body = JSON.parse(init.body);
      const current = files.get(path);
      if (body.sha && current && body.sha !== current.sha) {
        return new Response(JSON.stringify({ message: "conflict" }), { status: 409 });
      }
      const sha = `sha-${++shaN}`;
      files.set(path, { content: body.content, sha });
      return new Response(JSON.stringify({ content: { sha } }), { status: 201 });
    }
    const row = files.get(path);
    if (!row) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify({ content: row.content, sha: row.sha, encoding: "base64" }), { status: 200 });
  }
  if (target.hostname === "generativelanguage.googleapis.com") {
    const body = JSON.parse(init.body);
    const key = init.headers["x-goog-api-key"];
    const model = decodeURIComponent(target.pathname.match(/models\/([^:]+):/)[1]);
    lastPrompt = JSON.stringify(body);
    const task = lastPrompt;
    calls.push({ key, model, task: (task.match(/\[task:(\w+)\]/) || [])[1] || "?" });
    if (key === "RATE_LIMITED_KEY_0000000000") {
      return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric: requests per minute" } }), { status: 429 });
    }
    assert.equal(body.generationConfig?.temperature, undefined);
    let text = "Take the first step, then tell me what you notice.";
    if (task.includes("[task:extract]")) {
      text = JSON.stringify({ subject: "Biology", topics: [{ name: "Photosynthesis", subtopics: ["Chlorophyll", "Leaf"] }], notes: "Photosynthesis happens in the leaf. Chlorophyll absorbs light energy to make glucose." });
    } else if (task.includes("[task:lesson]")) {
      text = JSON.stringify({
        subject: "Biology",
        topic: "Photosynthesis",
        layout: "two",
        followUp: { exercise: true, reason: "Practise while it is fresh." },
        segments: [1, 2, 3, 4].map((n) => ({
          kind: n === 1 ? "title" : "point",
          section: 1,
          speech: `Sentence ${n} for the class.`,
          elements: [{ type: n === 1 ? "title" : "text", text: `Board line ${n}` }],
        })),
      });
    } else if (task.includes("[task:exercise]")) {
      text = JSON.stringify({
        title: "Photosynthesis check",
        subject: "Biology",
        topic: "Photosynthesis",
        difficulty: "medium",
        questions: [
          { id: "q1", type: "mcq", prompt: "Where does it happen?", choices: ["Root", "Leaf", "Bark", "Soil"], answer: "Leaf", explanation: "In the leaf." },
          { id: "q2", type: "mcq", prompt: "Which pigment absorbs light?", choices: ["Chlorophyll", "Keratin", "Melanin", "Haemoglobin"], answer: "Chlorophyll", explanation: "Chlorophyll." },
          { id: "q3", type: "essay", prompt: "Describe photosynthesis.", modelPoints: ["leaf", "light"] },
        ],
      });
    } else if (task.includes("[task:grade]")) {
      text = JSON.stringify({ score: 2, maxScore: 5, summary: "A fair start.", questions: [{ id: "q1", score: 1, max: 1, feedback: "Yes." }] });
    } else if (task.includes("[task:plan]")) {
      text = JSON.stringify({
        summary: "Six steady days.",
        next: { action: "class", subject: "Biology", topic: "Photosynthesis", reason: "It is the first topic in your notes." },
        timetable: { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => ({
          day,
          blocks: day === "Sunday" ? [] : [{ start: "16:00", end: "17:00", subject: "Biology", task: "Leaf diagram", activity: "class" }],
        })) },
        vision: "You are building toward the paper one topic at a time.",
        announcements: ["Bring yesterday's diagram."],
        weakTopics: [],
      });
    } else if (task.includes("[task:ask]")) {
      text = JSON.stringify({ answer: "Look at the vein again.", speech: "Look at the vein again." });
    } else if (task.includes("[task:test]")) {
      text = "OK";
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected fetch ${target}`);
};

const { default: worker } = await import("../worker.js");
const { CoordCore, memoryStorage, dayKey, nextResetAt } = await import("../coordinator.js");
const env = {
  GITHUB_TOKEN: "ghp_test",
  GITHUB_OWNER: "student",
  GITHUB_REPO: "aidata",
  GITHUB_BRANCH: "main",
  GEMINI_API_KEY: "test-key-AAAAAAAAAAAAAAAAAAAA",
  GEMINI_MODEL: "gemini-3.5-flash-lite",
  AUTH_SECRET: "test-secret",
  ADMIN_SECRET: "admin-pass",
  ASSETS: {
    async fetch() {
      return new Response("<!doctype html><title>Study Helper</title><h1>Study Helper</h1>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
};
const ctx = { waitUntil() {} };

async function call(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const init = { method: options.method || "GET", headers };
  if (options.json) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.json);
  }
  if (options.form) init.body = options.form;
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  const res = await worker.fetch(new Request(`http://local${path}`, init), env, ctx);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

function docxForm(text, fields = {}, name = "notes.docx") {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  const form = new FormData();
  form.append("file", new Blob([zipDocx(xml)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), name);
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  return form;
}

async function newStudent(name) {
  const reg = await call("/api/auth/register", { method: "POST", json: { username: name, password: "secret1" } });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  const token = reg.data.token;
  const profile = await call("/api/profile", {
    method: "PUT",
    token,
    json: { name: `${name} Banda`, age: 16, level: "senior-secondary", grade: "Form 4", examBoard: "MANEB", subjects: ["Biology", "Mathematics"], examDate: "2026-11-20", studyHours: 2.5 },
  });
  assert.equal(profile.status, 200, JSON.stringify(profile.data));
  return token;
}

// ---------- basics ----------
const opt = await call("/api/auth/login", { method: "OPTIONS" });
assert.equal(opt.status, 204);
assert.equal(opt.headers.get("access-control-allow-origin"), "*");
assert.match(String((await call("/")).data), /Study Helper/);

const setup = await call("/api/setup");
assert.equal(setup.data.ok, true);
assert.equal(setup.data.admin, true);

const reg = await call("/api/auth/register", { method: "POST", json: { username: "Chikondi", password: "secret1" } });
assert.equal(reg.status, 201, JSON.stringify(reg.data));
assert.equal(reg.data.profile.username, "chikondi");
assert.equal(reg.data.profile.passwordHash, undefined);
const token = reg.data.token;
assert.equal((await call("/api/auth/register", { method: "POST", json: { username: "chikondi", password: "secret1" } })).status, 409);
assert.equal((await call("/api/auth/login", { method: "POST", json: { username: "chikondi", password: "nope" } })).status, 401);
assert.equal((await call("/api/auth/login", { method: "POST", json: { username: "chikondi", password: "secret1" } })).status, 200);

// profile: exam board + college fields
const profile = await call("/api/profile", {
  method: "PUT",
  token,
  json: { name: "Chikondi Banda", age: 16, level: "senior-secondary", grade: "Form 4", examBoard: "MANEB", subjects: ["Biology", "Mathematics"], examDate: "2026-11-20", studyHours: 2.5 },
});
assert.equal(profile.status, 200, JSON.stringify(profile.data));
assert.equal(profile.data.profile.examBoard, "MANEB");
assert.equal(profile.data.profile.level, "senior-secondary");
const college = await call("/api/profile", {
  method: "PUT",
  token: (await call("/api/auth/register", { method: "POST", json: { username: "uni.student", password: "secret1" } })).data.token,
  json: { name: "Uni Student", age: 21, level: "college", grade: "Year 2", institution: "University of Malawi", course: "BSc Computer Science", examBoard: "University or college exams", subjects: ["Algorithms"] },
});
assert.equal(college.data.profile.institution, "University of Malawi");
assert.equal((await call("/api/profile", { method: "PUT", token, json: { level: "nonsense" } })).status, 400);

const boot = await call("/api/bootstrap", { token });
assert.equal(boot.data.profile.name, "Chikondi Banda");
assert.equal(boot.data.quota.used, 0);
assert.equal(boot.data.teacher.planStale, true);

// ---------- the teacher refuses to teach without notes ----------
for (const [path, json] of [["/api/chat", { message: "hi" }], ["/api/classroom/start", {}], ["/api/exercises/generate", {}], ["/api/teacher/plan", {}]]) {
  const res = await call(path, { method: "POST", token, json });
  assert.equal(res.status, 409, `${path} ${JSON.stringify(res.data)}`);
  assert.equal(res.data.code, "no_notes");
}
const wasted = (await call("/api/quota", { token })).data.quota.used;
assert.equal(wasted, 0, "refusals must not use quota");

// ---------- uploads: 1 MB cap, parts merge, notes are stored ----------
const big = new FormData();
big.append("file", new Blob([new Uint8Array(1024 * 1024 + 1)], { type: "application/pdf" }), "big.pdf");
assert.equal((await call("/api/materials/upload", { method: "POST", token, form: big })).status, 413);

const part1 = await call("/api/materials/upload", { method: "POST", token, form: docxForm("Photosynthesis happens in the leaf.", { groupId: "g1", part: 1, parts: 2, displayName: "biology.docx" }) });
assert.equal(part1.status, 201, JSON.stringify(part1.data));
assert.equal(part1.data.material.topics[0].name, "Photosynthesis");
assert.match(lastPrompt, /Photosynthesis happens in the leaf/);
const part2 = await call("/api/materials/upload", { method: "POST", token, form: docxForm("Chlorophyll absorbs light energy.", { groupId: "g1", part: 2, parts: 2, displayName: "biology.docx" }) });
assert.equal(part2.status, 201);
assert.equal(part2.data.material.id, part1.data.material.id, "parts of one file merge into one material");
assert.equal(part2.data.material.partsDone, 2);
const mats = (await call("/api/materials", { token })).data.materials;
assert.equal(mats.length, 1);
const notesFileKey = [...files.keys()].find((k) => k.startsWith("notes-"));
assert.ok(notesFileKey, "notes are kept for grounding");

// ---------- the teacher plans by herself ----------
const planned = await call("/api/teacher/plan", { method: "POST", token, json: { language: "en" } });
assert.equal(planned.status, 200, JSON.stringify(planned.data));
assert.equal(planned.data.teacher.timetable.days.length, 7);
assert.equal(planned.data.teacher.next.topic, "Photosynthesis");
assert.equal(planned.data.teacher.planStale, false);
assert.match(planned.data.teacher.vision.statement, /topic/);
assert.match(lastPrompt, /SOURCE RULE/);
assert.match(lastPrompt, /MANEB/);
assert.match(lastPrompt, /the student does not tell you what to do/i);

// ---------- chat is grounded in notes ----------
const chat = await call("/api/chat", { method: "POST", token, json: { message: "What does chlorophyll do?", history: [] } });
assert.equal(chat.status, 200, JSON.stringify(chat.data));
assert.match(chat.data.reply, /step/i);
assert.match(lastPrompt, /Chlorophyll absorbs light energy/);
assert.ok(chat.data.quota.used >= 1);

// ---------- live class takes no topic and follows the notes ----------
const lesson = await call("/api/classroom/start", { method: "POST", token, json: { language: "ny" } });
assert.equal(lesson.status, 200, JSON.stringify(lesson.data));
assert.ok(lesson.data.lesson.segments.length >= 4);
assert.equal(lesson.data.lesson.language, "ny");
assert.equal(lesson.data.lesson.followUp.exercise, true);
assert.match(lastPrompt, /Photosynthesis happens in the leaf/);
assert.match(lastPrompt, /Chichewa/);
const ask = await call("/api/classroom/ask", { method: "POST", token, json: { question: "why?", topic: "Photosynthesis", subject: "Biology" } });
assert.equal(ask.status, 200);
assert.equal((await call("/api/classroom/complete", { method: "POST", token, json: { subject: "Biology", topic: "Photosynthesis" } })).status, 200);

// ---------- the teacher sets the exercise herself ----------
const exercise = await call("/api/exercises/generate", { method: "POST", token, json: { language: "en" } });
assert.equal(exercise.status, 201, JSON.stringify(exercise.data));
assert.equal(exercise.data.exercise.questions[0].answer, undefined);
assert.equal(exercise.data.exercise.topic, "Photosynthesis");
assert.match(lastPrompt, /decide the topic, the number of questions/i);
const grade = await call("/api/exercises/grade", { method: "POST", token, json: { exerciseId: exercise.data.exercise.id, answers: [{ id: "q1", text: "Leaf" }] } });
assert.equal(grade.status, 200, JSON.stringify(grade.data));
assert.equal(grade.data.grade.score, 2);
const after = await call("/api/bootstrap", { token });
assert.equal(after.data.teacher.planStale, true, "class and results make the teacher re-plan");
assert.equal(after.data.teacher.results[0].score, 2);
assert.equal(after.data.teacher.exercises[0].graded, true);
assert.deepEqual(after.data.teacher.learnedTopics, ["Biology: Photosynthesis"]);

// ---------- admin ----------
assert.equal((await call("/api/admin/monitor")).status, 401);
assert.equal((await call("/api/admin/monitor", { token })).status, 401, "a student token is not an admin token");
assert.equal((await call("/api/admin/login", { method: "POST", json: { secret: "wrong" } })).status, 401);
const adminToken = (await call("/api/admin/login", { method: "POST", json: { secret: "admin-pass" } })).data.token;
assert.ok(adminToken);
assert.equal((await call("/api/bootstrap", { token: adminToken })).status, 401, "an admin token is not a student");

let mon = (await call("/api/admin/monitor", { token: adminToken })).data;
assert.equal(mon.entries.length, 1);
assert.equal(mon.entries[0].id, "env");
assert.ok(mon.capacity.usedToday >= 5);
assert.ok(mon.kinds.lesson >= 1 && mon.kinds.upload >= 2);
assert.equal(JSON.stringify(mon).includes("test-key-AAAAAAAAAAAAAAAAAAAA"), false, "keys never leave the server");

const badAdd = await call("/api/admin/models", { method: "POST", token: adminToken, json: { key: "short", models: "gemini-x" } });
assert.equal(badAdd.status, 400);
const KEY_B = "AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const add = await call("/api/admin/models", { method: "POST", token: adminToken, json: { label: "Second account", key: KEY_B, models: "gemini-3.5-flash-lite, gemini-2.5-flash", rpm: 15, rpd: 500 } });
assert.equal(add.status, 201, JSON.stringify(add.data));
assert.equal(add.data.added.length, 2);
assert.equal((await call("/api/admin/models", { method: "POST", token: adminToken, json: { key: KEY_B, models: "gemini-2.5-flash" } })).status, 409);
mon = (await call("/api/admin/monitor", { token: adminToken })).data;
assert.equal(mon.entries.length, 3);
assert.ok(mon.entries.every((e) => !JSON.stringify(e).includes(KEY_B)));
assert.ok(mon.capacity.daily === 1500);
const modelId = add.data.added[1];
const tested = await call("/api/admin/models/test", { method: "POST", token: adminToken, json: { id: modelId } });
assert.equal(tested.data.ok, true, JSON.stringify(tested.data));
assert.equal(calls.at(-1).model, "gemini-2.5-flash");
assert.equal(calls.at(-1).key, KEY_B);

// requests spread across the pool
const beforeCalls = calls.length;
const helper = await newStudent("spreader");
await call("/api/materials/upload", { method: "POST", token: helper, form: docxForm("Cells are the basic unit of life.", { groupId: "s1" }) });
for (let i = 0; i < 6; i += 1) await call("/api/chat", { method: "POST", token: helper, json: { message: `question ${i} about cells` } });
const used = new Set(calls.slice(beforeCalls).map((c) => `${c.key}|${c.model}`));
assert.ok(used.size >= 2, `load should be shared, saw ${[...used].join(", ")}`);

// a key that Google rate-limits is skipped and rests; the student is not charged for the miss
const BAD = "RATE_LIMITED_KEY_0000000000";
await call("/api/admin/models", { method: "POST", token: adminToken, json: { label: "Bad", key: BAD, models: "gemini-3.5-flash-lite", rpm: 1, rpd: 1 } });
for (const id of mon.entries.map((e) => e.id)) await call("/api/admin/models", { method: "PUT", token: adminToken, json: { id, patch: { enabled: false } } });
const badId = (await call("/api/admin/monitor", { token: adminToken })).data.entries.find((e) => e.keyHint.endsWith("0000")).id;
await call("/api/admin/models", { method: "PUT", token: adminToken, json: { id: badId, patch: { enabled: true, rpm: 5, rpd: 50 } } });
await call("/api/admin/models", { method: "PUT", token: adminToken, json: { id: "env", patch: { enabled: true } } });
const quotaBefore = (await call("/api/quota", { token: helper })).data.quota.used;
const failover = await call("/api/chat", { method: "POST", token: helper, json: { message: "failover question about cells" } });
assert.equal(failover.status, 200, JSON.stringify(failover.data));
assert.equal(failover.data.quota.used, quotaBefore + 1, "a rate-limited attempt is refunded");
mon = (await call("/api/admin/monitor", { token: adminToken })).data;
assert.ok(mon.entries.find((e) => e.id === badId).status === "cooling" || calls.every((c) => c.key !== BAD), "the limited key rests");
for (const id of mon.entries.map((e) => e.id)) await call("/api/admin/models", { method: "PUT", token: adminToken, json: { id, patch: { enabled: true } } });
assert.equal((await call("/api/admin/models", { method: "DELETE", token: adminToken, json: { id: badId } })).status, 200);
assert.equal((await call("/api/admin/models", { method: "DELETE", token: adminToken, json: { id: "env" } })).status, 400);

// ---------- daily limits ----------
const limited = await newStudent("limited");
await call("/api/materials/upload", { method: "POST", token: limited, form: docxForm("Fractions show parts of a whole.", { groupId: "l1" }) });
await call("/api/admin/settings", { method: "PUT", token: adminToken, json: { patch: { dailyUserLimit: 4, minUserLimit: 4, autoScale: false, criticalBonusPct: 25 } } });
const start = (await call("/api/quota", { token: limited })).data.quota;
assert.equal(start.limit, 4);
assert.equal(start.used, 1, "the upload used one request");
for (let i = 0; i < 3; i += 1) assert.equal((await call("/api/chat", { method: "POST", token: limited, json: { message: `q${i}` } })).status, 200);
const blocked = await call("/api/chat", { method: "POST", token: limited, json: { message: "one too many" } });
assert.equal(blocked.status, 429, JSON.stringify(blocked.data));
assert.equal(blocked.data.code, "user_quota");
assert.match(blocked.data.error, /midnight/);
assert.ok(blocked.data.resetAt > Date.now());
const bonus = await call("/api/teacher/plan", { method: "POST", token: limited, json: {} });
assert.equal(bonus.status, 200, "classes, exercises and plans may use the extra allowance");
assert.equal((await call("/api/teacher/plan", { method: "POST", token: limited, json: {} })).status, 429, "the extra allowance is also limited");
await call("/api/admin/settings", { method: "PUT", token: adminToken, json: { patch: { dailyUserLimit: 25, minUserLimit: 8, autoScale: true } } });

// ---------- live classes take turns ----------
await call("/api/admin/settings", { method: "PUT", token: adminToken, json: { patch: { slotsPerEntry: 1 } } });
mon = (await call("/api/admin/monitor", { token: adminToken })).data;
const seats = mon.classes.slots;
assert.equal(seats, mon.entries.filter((e) => e.status !== "exhausted" && e.enabled).length);
const tokens = [];
for (let i = 0; i < seats + 2; i += 1) {
  const t = await newStudent(`turn${i}`);
  const up = await call("/api/materials/upload", { method: "POST", token: t, form: docxForm("Plants make their own food using sunlight.", { groupId: `t${i}` }) });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  tokens.push(t);
}
const results = [];
for (const t of tokens) results.push(await call("/api/classroom/start", { method: "POST", token: t, json: { language: "en" } }));
assert.deepEqual(results.map((r) => r.status), [...Array(seats).fill(200), 202, 202]);
assert.equal(results[seats].data.position, 1);
assert.equal(results[seats + 1].data.position, 2);
assert.match(results[seats].data.message, /number 1/);
mon = (await call("/api/admin/monitor", { token: adminToken })).data;
assert.equal(mon.classes.active, seats);
assert.equal(mon.classes.waiting, 2);
assert.equal(mon.health.status, "saturated");
// the second in line cannot jump ahead of the first
const jump = await call("/api/classroom/start", { method: "POST", token: tokens[seats + 1], json: {} });
assert.equal(jump.status, 202);
assert.equal(jump.data.position, 2);
// a student finishes; the first in line gets the seat
await call("/api/classroom/complete", { method: "POST", token: tokens[0], json: { subject: "Biology", topic: "Plants" } });
const turn = await call("/api/classroom/start", { method: "POST", token: tokens[seats], json: { language: "en" } });
assert.equal(turn.status, 200, JSON.stringify(turn.data));
assert.equal((await call("/api/classroom/start", { method: "POST", token: tokens[seats + 1], json: {} })).data.position, 1);
// leaving frees a seat too
await call("/api/classroom/leave", { method: "POST", token: tokens[1] });
assert.equal((await call("/api/classroom/start", { method: "POST", token: tokens[seats + 1], json: {} })).status, 200);
await call("/api/admin/settings", { method: "PUT", token: adminToken, json: { patch: { slotsPerEntry: 4 } } });

// ---------- coordinator rules (clock under test control) ----------
{
  let clock = Date.UTC(2026, 9, 25, 10, 0, 0); // 12:00 in Malawi
  const core = new CoordCore(memoryStorage(), { secret: "s", now: () => clock });
  const envArg = { key: "K1-AAAAAAAAAAAAAAAAAAAAAA", model: "m1" };
  await core.handle("updateSettings", { env: envArg, patch: { dailyUserLimit: 3, minUserLimit: 1, autoScale: false } });
  await core.handle("updateEntry", { env: envArg, id: "env", patch: { rpm: 2, rpd: 100 } });
  const take = (userId) => core.handle("acquire", { env: envArg, userId, kind: "chat" });
  assert.equal((await take("a")).ok, true);
  assert.equal((await take("a")).ok, true);
  const rpm = await take("b");
  assert.equal(rpm.ok, false);
  assert.equal(rpm.code, "busy", "per-minute budget of the key is respected");
  assert.ok(rpm.retryAfterMs > 0 && rpm.retryAfterMs <= 60100);
  clock += 61000;
  assert.equal((await take("a")).ok, true);
  assert.equal((await take("a")).code, "user_quota");
  // limits refresh at midnight Malawi time, not at midnight UTC
  clock = Date.UTC(2026, 9, 25, 21, 59, 0);
  assert.equal(dayKey(clock), "2026-10-25");
  assert.equal((await take("a")).code, "user_quota");
  clock = Date.UTC(2026, 9, 25, 22, 1, 0);
  assert.equal(dayKey(clock), "2026-10-26");
  assert.equal((await take("a")).ok, true, "a new day gives a fresh allowance");
  assert.equal(nextResetAt(clock), Date.UTC(2026, 9, 26, 22, 0, 0));
  // pool exhaustion
  await core.handle("updateEntry", { env: envArg, id: "env", patch: { rpm: 100, rpd: 10 } });
  for (let i = 0; i < 8; i += 1) await core.handle("acquire", { env: envArg, userId: `f${i}`, kind: "lesson", critical: true });
  clock += 120000;
  const chatLow = await take("zed");
  assert.equal(chatLow.code, "pool_low", "chat stops first, keeping the last requests for classes and exercises");
  const lessonOk = await core.handle("acquire", { env: envArg, userId: "zed", kind: "lesson", critical: true });
  assert.equal(lessonOk.ok, true);
  const full = await core.handle("acquire", { env: envArg, userId: "zed", kind: "lesson", critical: true });
  assert.equal(full.ok, false);
  assert.equal(full.code, "pool_exhausted");
  // auto-scaling: more students -> smaller fair share, never below the floor
  const scale = new CoordCore(memoryStorage(), { secret: "s" });
  await scale.handle("updateSettings", { env: envArg, patch: { dailyUserLimit: 50, minUserLimit: 5, autoScale: true, reservePct: 10 } });
  await scale.handle("updateEntry", { env: envArg, id: "env", patch: { rpd: 500, rpm: 1000 } });
  const limitNow = async () => (await scale.handle("userStatus", { env: envArg, userId: "x" })).limit;
  assert.equal(await limitNow(), 50);
  for (let i = 0; i < 30; i += 1) await scale.handle("acquire", { env: envArg, userId: `u${i}`, kind: "chat" });
  assert.equal(await limitNow(), 15, "450 usable requests shared by 30 students");
  for (let i = 30; i < 200; i += 1) await scale.handle("acquire", { env: envArg, userId: `u${i}`, kind: "chat" });
  assert.equal(await limitNow(), 5, "the floor keeps studying possible");
}

console.log("self-check ok");
