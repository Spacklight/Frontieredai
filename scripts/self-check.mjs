import assert from "node:assert/strict";
import zlib from "node:zlib";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const files = new Map();
let shaN = 0;
let lastPrompt = "";

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
    lastPrompt = JSON.stringify(body);
    const task = lastPrompt;
    let text = "Take the first step, then tell me what you notice.";
    if (task.includes("[task:extract]")) {
      text = JSON.stringify({ subject: "Biology", topics: [{ name: "Photosynthesis", subtopics: ["Chlorophyll", "Leaf"] }] });
    } else if (task.includes("[task:lesson]")) {
      text = JSON.stringify({
        subject: "Biology",
        topic: "Leaf structure",
        layout: "two",
        segments: [1, 2, 3, 4].map((n) => ({
          kind: n === 1 ? "title" : "point",
          section: 1,
          speech: `Sentence ${n} for the class.`,
          elements: [{ type: n === 1 ? "title" : "text", text: `Board line ${n}` }],
        })),
      });
    } else if (task.includes("[task:exercise]")) {
      text = JSON.stringify({
        title: "Leaf check",
        questions: [
          { id: "q1", type: "mcq", prompt: "Where does it happen?", choices: ["Root", "Leaf", "Bark", "Soil"], answer: "Leaf", explanation: "In the leaf." },
          { id: "q2", type: "mcq", prompt: "Which gas is released?", choices: ["Oxygen", "Nitrogen", "Helium", "Argon"], answer: "Oxygen", explanation: "Oxygen." },
          { id: "q3", type: "essay", prompt: "Describe a leaf.", modelPoints: ["green", "veins"] },
        ],
      });
    } else if (task.includes("[task:grade]")) {
      text = JSON.stringify({ score: 2, maxScore: 5, summary: "A fair start.", questions: [{ id: "q1", score: 1, max: 1, feedback: "Yes." }] });
    } else if (task.includes("[task:timetable]")) {
      text = JSON.stringify({
        summary: "Six steady days.",
        days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => ({
          day,
          blocks: day === "Sunday" ? [] : [{ start: "16:00", end: "17:00", subject: "Biology", task: "Leaf diagram" }],
        })),
      });
    } else if (task.includes("[task:vision]")) {
      text = JSON.stringify({ statement: "You are building toward the paper one topic at a time.", announcements: ["Bring yesterday's diagram."], nextTopic: "Leaf structure", nextSubject: "Biology" });
    } else if (task.includes("[task:suggest]")) {
      text = JSON.stringify({ subject: "Biology", topic: "Leaf structure", reason: "It is the first gap." });
    } else if (task.includes("[task:ask]")) {
      text = JSON.stringify({ answer: "Look at the vein again.", speech: "Look at the vein again." });
    }
    assert.equal(body.generationConfig?.temperature, undefined);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected fetch ${target}`);
};

const { default: worker } = await import("../worker.js");
const env = {
  GITHUB_TOKEN: "ghp_test",
  GITHUB_OWNER: "student",
  GITHUB_REPO: "aidata",
  GITHUB_BRANCH: "main",
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-3.5-flash-lite",
  AUTH_SECRET: "test-secret",
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

const opt = await call("/api/auth/login", { method: "OPTIONS" });
assert.equal(opt.status, 204);
assert.equal(opt.headers.get("access-control-allow-origin"), "*");

const home = await call("/");
assert.equal(home.status, 200);
assert.match(String(home.data), /Study Helper/);

const setup = await call("/api/setup");
assert.equal(setup.data.ok, true);
assert.equal(setup.data.model, "gemini-3.5-flash-lite");

const reg = await call("/api/auth/register", { method: "POST", json: { username: "Chikondi", password: "secret1" } });
assert.equal(reg.status, 201, JSON.stringify(reg.data));
assert.equal(reg.data.profile.username, "chikondi");
assert.equal(reg.data.profile.passwordHash, undefined);
const token = reg.data.token;

const again = await call("/api/auth/register", { method: "POST", json: { username: "chikondi", password: "secret1" } });
assert.equal(again.status, 409);

const bad = await call("/api/auth/login", { method: "POST", json: { username: "chikondi", password: "nope" } });
assert.equal(bad.status, 401);

const good = await call("/api/auth/login", { method: "POST", json: { username: "chikondi", password: "secret1" } });
assert.equal(good.status, 200);

const profile = await call("/api/profile", {
  method: "PUT",
  token,
  json: { name: "Chikondi Banda", age: 16, grade: "Form 4", subjects: ["Biology", "Mathematics"], examDate: "2026-11-20", studyHours: 2.5 },
});
assert.equal(profile.status, 200, JSON.stringify(profile.data));
assert.deepEqual(profile.data.profile.subjects, ["Biology", "Mathematics"]);

const boot = await call("/api/bootstrap", { token });
assert.equal(boot.data.profile.name, "Chikondi Banda");

const chat = await call("/api/chat", { method: "POST", token, json: { message: "What is a leaf?", history: [] } });
assert.equal(chat.status, 200, JSON.stringify(chat.data));
assert.match(chat.data.reply, /step/i);

const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Photosynthesis happens in the leaf.</w:t></w:r></w:p></w:body></w:document>`;
const form = new FormData();
form.append("file", new Blob([zipDocx(xml)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "notes.docx");
form.append("subject", "Biology");
const uploaded = await call("/api/materials/upload", { method: "POST", token, form });
assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
assert.equal(uploaded.data.material.topics[0].name, "Photosynthesis");
assert.match(lastPrompt, /Photosynthesis happens in the leaf/);

const lesson = await call("/api/classroom/start", {
  method: "POST",
  token,
  json: { subject: "Biology", topic: "Leaf structure", language: "ny" },
});
assert.equal(lesson.status, 200, JSON.stringify(lesson.data));
assert.ok(lesson.data.lesson.segments.length >= 4);
assert.equal(lesson.data.lesson.language, "ny");

const exercise = await call("/api/exercises/generate", {
  method: "POST",
  token,
  json: { subject: "Biology", topic: "Leaf structure", language: "en" },
});
assert.equal(exercise.status, 201, JSON.stringify(exercise.data));
assert.equal(exercise.data.exercise.questions[0].answer, undefined);

const grade = await call("/api/exercises/grade", {
  method: "POST",
  token,
  json: { exerciseId: exercise.data.exercise.id, answers: [{ id: "q1", text: "Leaf" }] },
});
assert.equal(grade.status, 200, JSON.stringify(grade.data));
assert.equal(grade.data.grade.score, 2);
assert.match(lastPrompt, /Leaf/);

const week = await call("/api/timetable/generate", { method: "POST", token, json: { language: "en" } });
assert.equal(week.data.timetable.days.length, 7);

const vision = await call("/api/vision/refresh", { method: "POST", token, json: {} });
assert.match(vision.data.vision.statement, /topic/);

console.log("self-check ok");
