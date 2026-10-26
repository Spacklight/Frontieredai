/**
 * Study Helper — platform coordinator.
 *
 * One place that sees the whole platform:
 *  - the pool of Google AI Studio keys / models (admin managed, encrypted at rest)
 *  - per-minute and per-day request budgets for every key
 *  - fair daily limits per student (auto scaled, refresh at midnight Malawi time)
 *  - live-class slots and the waiting line ("turns")
 *  - the health picture the admin dashboard shows
 *
 * `CoordCore` is plain logic with an injected storage object, so it runs
 * (a) inside a Cloudflare Durable Object (`Coordinator`, below) and
 * (b) in memory / in a local JSON file for Termux and tests.
 */

const CAT_OFFSET = 2 * 3600 * 1000; // Malawi (Central Africa Time), no DST

export const DEFAULT_SETTINGS = {
  dailyUserLimit: 25, // most AI requests one student can use per day
  minUserLimit: 8, // auto-scaling never goes below this
  autoScale: true, // shrink the per-student limit when the platform is crowded
  criticalBonusPct: 25, // classes, exercises and plans may go this much over the limit
  reservePct: 10, // part of the daily capacity kept back for uploads and important work
  slotsPerEntry: 4, // live classes that one key/model can carry at once
  classIdleSeconds: 90, // a class with no heartbeat for this long frees its seat
  classMaxMinutes: 40,
  queuePatienceSeconds: 45, // a waiting student who stops checking in leaves the line
};

const DEFAULT_ENV_ENTRY = { enabled: true, rpm: 15, rpd: 500 };

export function dayKey(now) {
  return new Date(now + CAT_OFFSET).toISOString().slice(0, 10);
}

export function nextResetAt(now) {
  const d = new Date(now + CAT_OFFSET);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - CAT_OFFSET;
}

class CoordError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------- small crypto helpers (keys are encrypted before they are stored) ---------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 0x8000) bin += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromB64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesKey(secret) {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(`${secret}|study-helper-pool-v1`));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptText(secret, text) {
  if (!secret) throw new CoordError(500, "Set AUTH_SECRET (or POOL_SECRET) before adding keys.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(text));
  return `${toB64(iv)}.${toB64(ct)}`;
}

export async function decryptText(secret, packed) {
  const [iv, ct] = String(packed || "").split(".");
  if (!iv || !ct) throw new CoordError(500, "A stored key is damaged. Remove it and add it again.");
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await aesKey(secret), fromB64(ct));
    return dec.decode(plain);
  } catch {
    throw new CoordError(500, "Stored keys cannot be opened. AUTH_SECRET (or POOL_SECRET) changed since they were added — add them again.");
  }
}

async function shortHash(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clip(text, max) {
  const value = String(text ?? "");
  return value.length > max ? value.slice(0, max) : value;
}

function num(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* ---------- state ---------- */

function freshUsage(day) {
  return { day, users: {}, entries: {}, kinds: {}, denied: 0 };
}

function freshState(now) {
  return {
    v: 1,
    config: { entries: [], settings: { ...DEFAULT_SETTINGS }, env: { ...DEFAULT_ENV_ENTRY } },
    usage: freshUsage(dayKey(now)),
    history: [],
    classes: { active: {}, queue: [] },
    errors: [],
  };
}

function hydrate(saved, now) {
  const base = freshState(now);
  return {
    ...base,
    ...saved,
    config: {
      entries: Array.isArray(saved?.config?.entries) ? saved.config.entries : [],
      settings: { ...DEFAULT_SETTINGS, ...(saved?.config?.settings || {}) },
      env: { ...DEFAULT_ENV_ENTRY, ...(saved?.config?.env || {}) },
    },
    usage: { ...freshUsage(dayKey(now)), ...(saved?.usage || {}) },
    history: Array.isArray(saved?.history) ? saved.history : [],
    classes: {
      active: saved?.classes?.active || {},
      queue: Array.isArray(saved?.classes?.queue) ? saved.classes.queue : [],
    },
    errors: Array.isArray(saved?.errors) ? saved.errors : [],
  };
}

const MUTATING = new Set([
  "acquire", "report", "classEnter", "classBeat", "classLeave",
  "addEntries", "updateEntry", "deleteEntry", "updateSettings", "reserve",
]);

export class CoordCore {
  constructor(storage, { secret = "", now = () => Date.now() } = {}) {
    this.storage = storage;
    this.secret = secret;
    this.now = now;
    this.s = null;
    this.envEntry = null;
    this.rt = { hits: {}, cooldown: {}, exhausted: {}, lastError: {} };
    this.chain = Promise.resolve();
  }

  async init() {
    if (this.s) return;
    const saved = await this.storage.get("state");
    this.s = saved ? hydrate(saved, this.now()) : freshState(this.now());
  }

  handle(op, args = {}) {
    const run = this.chain.then(() => this.dispatch(op, args));
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  async save() {
    await this.storage.put("state", this.s);
  }

  async dispatch(op, args) {
    await this.init();
    this.syncEnv(args.env);
    this.rollover();
    const fn = this.ops[op];
    if (!fn) throw new CoordError(400, `Unknown coordinator op: ${op}`);
    const result = await fn.call(this, args);
    if (MUTATING.has(op)) await this.save();
    return result;
  }

  /* ----- bookkeeping ----- */

  syncEnv(env) {
    if (!env || !env.key) {
      this.envEntry = null;
      return;
    }
    const cfg = this.s.config.env;
    this.envEntry = {
      id: "env",
      source: "env",
      label: "Cloudflare secret key",
      model: env.model || "gemini-3.5-flash-lite",
      key: env.key,
      keyHint: `…${String(env.key).slice(-4)}`,
      rpm: cfg.rpm,
      rpd: cfg.rpd,
      enabled: cfg.enabled,
    };
  }

  rollover() {
    const today = dayKey(this.now());
    if (this.s.usage.day === today) return;
    const old = this.s.usage;
    const total = Object.values(old.entries).reduce((sum, n) => sum + n, 0);
    this.s.history.push({ day: old.day, total, users: Object.keys(old.users).length, denied: old.denied || 0 });
    this.s.history = this.s.history.slice(-30);
    this.s.usage = freshUsage(today);
  }

  entries() {
    const list = [];
    if (this.envEntry) list.push(this.envEntry);
    for (const entry of this.s.config.entries) list.push({ ...entry, source: "admin" });
    return list;
  }

  entryUsed(id) {
    return this.s.usage.entries[id] || 0;
  }

  rpmNow(id, now) {
    const hits = (this.rt.hits[id] || []).filter((t) => t > now - 60000);
    this.rt.hits[id] = hits;
    return hits.length;
  }

  status(entry, now) {
    if (!entry.enabled) return "disabled";
    if (this.rt.exhausted[entry.id] === this.s.usage.day || this.entryUsed(entry.id) >= entry.rpd) return "exhausted";
    if ((this.rt.cooldown[entry.id] || 0) > now) return "cooling";
    return "ok";
  }

  usableEntries(now) {
    return this.entries().filter((entry) => this.status(entry, now) === "ok" || this.status(entry, now) === "cooling");
  }

  pick(now, onlyId = "") {
    let best = null;
    let wait = Infinity;
    let anyAlive = false;
    for (const entry of this.entries()) {
      if (onlyId && entry.id !== onlyId) continue;
      const st = this.status(entry, now);
      if (st === "disabled" || st === "exhausted") continue;
      anyAlive = true;
      const cooling = Math.max(0, (this.rt.cooldown[entry.id] || 0) - now);
      const rpm = this.rpmNow(entry.id, now);
      let delay = cooling;
      if (rpm >= entry.rpm) {
        const oldest = Math.min(...this.rt.hits[entry.id]);
        delay = Math.max(delay, oldest + 60000 - now + 25);
      }
      if (delay > 0) {
        wait = Math.min(wait, delay);
        continue;
      }
      const score = this.entryUsed(entry.id) / entry.rpd + (rpm / entry.rpm) * 0.5;
      if (!best || score < best.score) best = { entry, score };
    }
    if (best) return { entry: best.entry };
    if (!anyAlive) {
      return { fail: { code: this.entries().length ? "pool_exhausted" : "no_models", resetAt: nextResetAt(now) } };
    }
    return { fail: { code: "busy", retryAfterMs: Math.ceil(wait) } };
  }

  capacity() {
    const live = this.entries().filter((e) => e.enabled);
    return {
      daily: live.reduce((sum, e) => sum + e.rpd, 0),
      rpm: live.reduce((sum, e) => sum + e.rpm, 0),
    };
  }

  totalUsed() {
    return Object.values(this.s.usage.entries).reduce((sum, n) => sum + n, 0);
  }

  effectiveLimit() {
    const set = this.s.config.settings;
    if (!set.autoScale) return set.dailyUserLimit;
    const cap = this.capacity().daily;
    const todayUsers = Object.keys(this.s.usage.users).length;
    const past = this.s.history.slice(-7).map((h) => h.users).filter((n) => n > 0);
    const avgPast = past.length ? Math.ceil(past.reduce((a, b) => a + b, 0) / past.length) : 0;
    const expected = Math.max(1, todayUsers, avgPast);
    const fair = Math.floor((cap * (100 - set.reservePct)) / 100 / expected);
    return Math.max(Math.min(set.minUserLimit, set.dailyUserLimit), Math.min(set.dailyUserLimit, fair));
  }

  classSlots(now) {
    const set = this.s.config.settings;
    const live = this.entries().filter((e) => this.status(e, now) === "ok" || this.status(e, now) === "cooling");
    return Math.max(live.length ? 1 : 0, Math.floor(live.length * set.slotsPerEntry));
  }

  health(now) {
    const live = this.entries().filter((e) => e.enabled && this.status(e, now) !== "exhausted");
    if (!live.length) {
      return { status: "closed", message: "The teacher is resting. Lessons reopen tomorrow morning." };
    }
    const rpmCap = live.reduce((sum, e) => sum + e.rpm, 0);
    const rpmUsed = live.reduce((sum, e) => sum + this.rpmNow(e.id, now), 0);
    const cap = this.capacity().daily || 1;
    const minutePct = rpmCap ? rpmUsed / rpmCap : 1;
    const dayPct = this.totalUsed() / cap;
    const waiting = this.s.classes.queue.length;
    if (minutePct >= 0.85 || dayPct >= 0.95 || waiting > 0) {
      return { status: "saturated", message: "Many students are learning right now. Live classes run in turns, and replies may wait a moment." };
    }
    if (minutePct >= 0.6 || dayPct >= 0.8) {
      return { status: "busy", message: "The teacher is busy. Replies may take a few extra seconds." };
    }
    return { status: "ok", message: "" };
  }

  pruneClasses(now) {
    const set = this.s.config.settings;
    const c = this.s.classes;
    for (const [id, row] of Object.entries(c.active)) {
      if (now - row.beat > set.classIdleSeconds * 1000 || now - row.since > set.classMaxMinutes * 60000) delete c.active[id];
    }
    c.queue = c.queue.filter((row) => now - row.beat <= set.queuePatienceSeconds * 1000);
  }

  logError(entryId, status, message) {
    this.s.errors.unshift({ at: this.now(), entryId: entryId || "", status: status || 0, message: clip(message, 200) });
    this.s.errors = this.s.errors.slice(0, 30);
  }

  /* ----- operations ----- */

  ops = {
    async acquire({ userId, kind = "chat", critical = false, free = false }) {
      const now = this.now();
      const set = this.s.config.settings;
      const limit = this.effectiveLimit();
      const used = this.s.usage.users[userId] || 0;
      const cap = critical ? Math.ceil((limit * (100 + set.criticalBonusPct)) / 100) : limit;
      const resetAt = nextResetAt(now);
      if (!free && used >= cap) {
        this.s.usage.denied += 1;
        return { ok: false, code: "user_quota", used, limit: cap, resetAt };
      }
      if (!free && !critical) {
        const softCap = (this.capacity().daily * (100 - set.reservePct)) / 100;
        if (this.capacity().daily && this.totalUsed() >= softCap) {
          this.s.usage.denied += 1;
          return { ok: false, code: "pool_low", resetAt };
        }
      }
      const picked = this.pick(now);
      if (picked.fail) {
        if (picked.fail.code !== "busy") this.s.usage.denied += 1;
        return { ok: false, ...picked.fail, resetAt };
      }
      const entry = picked.entry;
      const key = entry.source === "env" ? entry.key : await decryptText(this.secret, entry.keyEnc);
      (this.rt.hits[entry.id] ||= []).push(now);
      this.s.usage.entries[entry.id] = this.entryUsed(entry.id) + 1;
      this.s.usage.kinds[kind] = (this.s.usage.kinds[kind] || 0) + 1;
      if (!free) this.s.usage.users[userId] = used + 1;
      return {
        ok: true,
        lease: { entryId: entry.id, model: entry.model, key, free },
        quota: { used: free ? used : used + 1, limit, cap, resetAt },
      };
    },

    async report({ userId, entryId, outcome, status = 0, message = "", free = false }) {
      const now = this.now();
      if (outcome === "ok") return { ok: true };
      const text = String(message || "");
      if (!free && userId && this.s.usage.users[userId] > 0) this.s.usage.users[userId] -= 1;
      if (outcome === "rate_limit") {
        const daily = /per.?day|daily|requests per day|RequestsPerDay/i.test(text) && !/per.?minute/i.test(text);
        if (daily) this.rt.exhausted[entryId] = this.s.usage.day;
        else this.rt.cooldown[entryId] = now + 65000;
        this.rt.lastError[entryId] = daily ? "Daily limit reached at Google" : "Per-minute limit reached at Google";
      } else if (status === 400 || status === 401 || status === 403) {
        if (/api key|API_KEY|permission|denied|not found|invalid/i.test(text)) {
          this.rt.cooldown[entryId] = now + 10 * 60000;
          this.rt.lastError[entryId] = clip(text, 120);
        }
      } else if (status >= 500) {
        this.rt.cooldown[entryId] = now + 20000;
        this.rt.lastError[entryId] = "Google was unavailable";
      }
      this.logError(entryId, status, text);
      return { ok: true };
    },

    async reserve({ id }) {
      const now = this.now();
      const picked = this.pick(now, id);
      if (picked.fail) return { ok: false, ...picked.fail };
      const entry = picked.entry;
      const key = entry.source === "env" ? entry.key : await decryptText(this.secret, entry.keyEnc);
      (this.rt.hits[entry.id] ||= []).push(now);
      this.s.usage.entries[entry.id] = this.entryUsed(entry.id) + 1;
      this.s.usage.kinds.test = (this.s.usage.kinds.test || 0) + 1;
      return { ok: true, lease: { entryId: entry.id, model: entry.model, key, free: true } };
    },

    async userStatus({ userId }) {
      const now = this.now();
      const limit = this.effectiveLimit();
      const used = this.s.usage.users[userId] || 0;
      return {
        used,
        limit,
        remaining: Math.max(0, limit - used),
        resetAt: nextResetAt(now),
        health: this.health(now),
        poolOpen: this.entries().some((e) => e.enabled),
      };
    },

    async poolInfo() {
      const now = this.now();
      return {
        entries: this.entries().filter((e) => e.enabled).length,
        usable: this.usableEntries(now).length,
        health: this.health(now),
      };
    },

    async classEnter({ userId }) {
      const now = this.now();
      this.pruneClasses(now);
      const c = this.s.classes;
      const slots = this.classSlots(now);
      if (!slots) return { state: "closed", slots: 0, resetAt: nextResetAt(now) };
      if (c.active[userId]) {
        c.active[userId].beat = now;
        return { state: "active", slots, active: Object.keys(c.active).length, waiting: c.queue.length };
      }
      let row = c.queue.find((item) => item.userId === userId);
      if (row) row.beat = now;
      else {
        row = { userId, since: now, beat: now };
        c.queue.push(row);
      }
      const index = c.queue.indexOf(row);
      const activeCount = Object.keys(c.active).length;
      const free = Math.max(0, slots - activeCount);
      if (index < free) {
        c.queue.splice(index, 1);
        c.active[userId] = { since: now, beat: now };
        return { state: "active", slots, active: activeCount + 1, waiting: c.queue.length };
      }
      const turnsAhead = index - free + 1;
      return {
        state: "waiting",
        position: index + 1,
        slots,
        active: activeCount,
        waiting: c.queue.length,
        etaMinutes: Math.max(1, Math.ceil(turnsAhead / Math.max(1, slots)) * 8),
      };
    },

    async classBeat({ userId }) {
      const now = this.now();
      const row = this.s.classes.active[userId];
      if (row) row.beat = now;
      return { active: Boolean(row) };
    },

    async classLeave({ userId }) {
      delete this.s.classes.active[userId];
      this.s.classes.queue = this.s.classes.queue.filter((row) => row.userId !== userId);
      return { ok: true };
    },

    async monitor() {
      const now = this.now();
      this.pruneClasses(now);
      const cap = this.capacity();
      const limit = this.effectiveLimit();
      const users = this.s.usage.users;
      const history = [...this.s.history.slice(-6), {
        day: this.s.usage.day,
        total: this.totalUsed(),
        users: Object.keys(users).length,
        denied: this.s.usage.denied,
        today: true,
      }];
      const expectedDemand = Math.max(
        Object.keys(users).length,
        ...this.s.history.slice(-7).map((h) => h.users),
      ) * this.s.config.settings.dailyUserLimit;
      return {
        now,
        day: this.s.usage.day,
        resetAt: nextResetAt(now),
        settings: this.s.config.settings,
        health: this.health(now),
        effectiveUserLimit: limit,
        capacity: {
          daily: cap.daily,
          rpm: cap.rpm,
          usedToday: this.totalUsed(),
          rpmNow: this.entries().reduce((sum, e) => sum + this.rpmNow(e.id, now), 0),
          expectedDemand,
        },
        users: { today: Object.keys(users).length },
        classes: {
          slots: this.classSlots(now),
          active: Object.keys(this.s.classes.active).length,
          waiting: this.s.classes.queue.length,
          activeIds: Object.keys(this.s.classes.active),
          queueIds: this.s.classes.queue.map((row) => row.userId),
        },
        entries: this.entries().map((e) => ({
          id: e.id,
          source: e.source,
          label: e.label,
          model: e.model,
          keyHint: e.keyHint,
          enabled: e.enabled,
          rpm: e.rpm,
          rpd: e.rpd,
          usedToday: this.entryUsed(e.id),
          rpmNow: this.rpmNow(e.id, now),
          status: this.status(e, now),
          cooldownSec: Math.max(0, Math.ceil(((this.rt.cooldown[e.id] || 0) - now) / 1000)),
          lastError: this.rt.lastError[e.id] || "",
        })),
        kinds: this.s.usage.kinds,
        denied: this.s.usage.denied,
        history,
        errors: this.s.errors.slice(0, 12),
        perUser: Object.entries(users).map(([id, used]) => ({ id, used })).sort((a, b) => b.used - a.used).slice(0, 60),
        persistent: true,
      };
    },

    async addEntries({ label, key, models, rpm, rpd }) {
      const cleanKey = String(key || "").trim();
      if (!/^[A-Za-z0-9_\-]{20,220}$/.test(cleanKey)) {
        throw new CoordError(400, "That does not look like a Google AI Studio API key.");
      }
      const list = [...new Set((Array.isArray(models) ? models : String(models || "").split(/[,\s]+/)).map((m) => String(m).trim()).filter(Boolean))].slice(0, 12);
      if (!list.length) throw new CoordError(400, "Add at least one model name, e.g. gemini-3.5-flash-lite.");
      for (const model of list) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(model)) throw new CoordError(400, `"${model}" is not a valid model name.`);
      }
      const cleanLabel = clip(String(label || "").trim() || `Key …${cleanKey.slice(-4)}`, 60);
      const added = [];
      for (const model of list) {
        const hash = await shortHash(`${cleanKey}|${model}`);
        if (this.s.config.entries.some((e) => e.hash === hash)) continue;
        const entry = {
          id: `m_${hash}`,
          hash,
          label: cleanLabel,
          model,
          keyEnc: await encryptText(this.secret, cleanKey),
          keyHint: `…${cleanKey.slice(-4)}`,
          rpm: num(rpm, 1, 2000, 15),
          rpd: num(rpd, 1, 200000, 500),
          enabled: true,
          createdAt: this.now(),
        };
        this.s.config.entries.push(entry);
        added.push(entry.id);
      }
      if (!added.length) throw new CoordError(409, "That key and model are already in the pool.");
      return { added };
    },

    async updateEntry({ id, patch = {} }) {
      if (id === "env") {
        const cfg = this.s.config.env;
        if (patch.enabled !== undefined) cfg.enabled = Boolean(patch.enabled);
        if (patch.rpm !== undefined) cfg.rpm = num(patch.rpm, 1, 2000, cfg.rpm);
        if (patch.rpd !== undefined) cfg.rpd = num(patch.rpd, 1, 200000, cfg.rpd);
        return { ok: true };
      }
      const entry = this.s.config.entries.find((e) => e.id === id);
      if (!entry) throw new CoordError(404, "That model is not in the pool.");
      if (patch.enabled !== undefined) entry.enabled = Boolean(patch.enabled);
      if (patch.label !== undefined) entry.label = clip(String(patch.label).trim(), 60) || entry.label;
      if (patch.rpm !== undefined) entry.rpm = num(patch.rpm, 1, 2000, entry.rpm);
      if (patch.rpd !== undefined) entry.rpd = num(patch.rpd, 1, 200000, entry.rpd);
      if (patch.model !== undefined) {
        const model = String(patch.model).trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(model)) throw new CoordError(400, "That is not a valid model name.");
        entry.model = model;
      }
      delete this.rt.cooldown[id];
      delete this.rt.exhausted[id];
      return { ok: true };
    },

    async deleteEntry({ id }) {
      if (id === "env") throw new CoordError(400, "The Cloudflare secret key cannot be deleted here. Disable it instead.");
      const before = this.s.config.entries.length;
      this.s.config.entries = this.s.config.entries.filter((e) => e.id !== id);
      if (this.s.config.entries.length === before) throw new CoordError(404, "That model is not in the pool.");
      return { ok: true };
    },

    async updateSettings({ patch = {} }) {
      const set = this.s.config.settings;
      if (patch.dailyUserLimit !== undefined) set.dailyUserLimit = num(patch.dailyUserLimit, 1, 1000, set.dailyUserLimit);
      if (patch.minUserLimit !== undefined) set.minUserLimit = num(patch.minUserLimit, 1, 500, set.minUserLimit);
      if (patch.autoScale !== undefined) set.autoScale = Boolean(patch.autoScale);
      if (patch.criticalBonusPct !== undefined) set.criticalBonusPct = num(patch.criticalBonusPct, 0, 200, set.criticalBonusPct);
      if (patch.reservePct !== undefined) set.reservePct = num(patch.reservePct, 0, 50, set.reservePct);
      if (patch.slotsPerEntry !== undefined) set.slotsPerEntry = num(patch.slotsPerEntry, 1, 30, set.slotsPerEntry);
      if (patch.classIdleSeconds !== undefined) set.classIdleSeconds = num(patch.classIdleSeconds, 30, 600, set.classIdleSeconds);
      if (patch.classMaxMinutes !== undefined) set.classMaxMinutes = num(patch.classMaxMinutes, 5, 120, set.classMaxMinutes);
      if (patch.queuePatienceSeconds !== undefined) set.queuePatienceSeconds = num(patch.queuePatienceSeconds, 15, 300, set.queuePatienceSeconds);
      if (set.minUserLimit > set.dailyUserLimit) set.minUserLimit = set.dailyUserLimit;
      return { settings: set };
    },
  };
}

/* ---------- storage adapters ---------- */

export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
  };
}

/** Cloudflare Durable Object (SQLite-backed). Bound as COORD in wrangler.jsonc. */
export class Coordinator {
  constructor(state, env) {
    this.state = state;
    this.core = new CoordCore(state.storage, { secret: env.POOL_SECRET || env.AUTH_SECRET || env.GITHUB_TOKEN || "" });
    state.blockConcurrencyWhile(() => this.core.init());
  }

  async fetch(request) {
    let body;
    try {
      body = await request.json();
      const result = await this.core.handle(body.op, body.args || {});
      return Response.json({ ok: true, result });
    } catch (err) {
      return Response.json({ ok: false, error: err.message || "Coordinator error", status: err.status || 500 });
    }
  }
}
