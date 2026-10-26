const $ = (sel) => document.querySelector(sel);
let token = sessionStorage.getItem("sh_admin") || "";
let timer = null;

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  $("#toast-root").append(node);
  setTimeout(() => node.remove(), 4800);
}

async function api(path, { method = "GET", json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(path, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/admin/login") signOut();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function signOut() {
  token = "";
  sessionStorage.removeItem("sh_admin");
  clearInterval(timer);
  $("#dash").hidden = true;
  $("#login").hidden = false;
}

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

const fmt = (n) => Number(n || 0).toLocaleString();

function render(m) {
  const pill = $("#health-pill");
  pill.dataset.s = m.health.status;
  pill.textContent = { ok: "Healthy", busy: "Busy", saturated: "Crowded — classes in turns", closed: "No capacity left" }[m.health.status] || m.health.status;
  $("#updated").textContent = `Updated ${new Date(m.now).toLocaleTimeString()}`;
  const warn = $("#warn");
  const warnings = [];
  if (!m.persistent) warnings.push("The coordinator is not bound, so keys and counts live in memory only. On Cloudflare, check the COORD binding in wrangler.jsonc.");
  if (!m.entries.some((e) => e.enabled)) warnings.push("No model is switched on. Students cannot get lessons until you add or enable one.");
  if (m.capacity.expectedDemand > m.capacity.daily && m.capacity.daily) {
    warnings.push(`Expected demand (~${fmt(m.capacity.expectedDemand)} requests a day) is above your capacity (${fmt(m.capacity.daily)}). Add more keys, or lower the per-student target.`);
  }
  warn.hidden = !warnings.length;
  warn.textContent = warnings.join(" ");

  $("#s-used").textContent = fmt(m.capacity.usedToday);
  $("#s-cap").textContent = `of ${fmt(m.capacity.daily)} available today · resets in ${untilText(m.resetAt, m.now)}`;
  $("#s-meter").style.width = `${Math.min(100, Math.round((m.capacity.usedToday / Math.max(1, m.capacity.daily)) * 100))}%`;
  $("#s-limit").textContent = m.effectiveUserLimit;
  $("#s-users").textContent = `${m.users.today} active today${m.users.registered ? ` · ${m.users.registered} registered` : ""} · ${m.denied} turned away`;
  $("#s-classes").textContent = `${m.classes.active} / ${m.classes.slots}`;
  $("#s-queue").textContent = m.classes.waiting ? `${m.classes.waiting} waiting in line` : "no one waiting";
  $("#s-rpm").textContent = m.capacity.rpmNow;
  $("#s-rpmcap").textContent = `of ${fmt(m.capacity.rpm)} per minute`;

  const body = $("#pool tbody");
  body.innerHTML = "";
  if (!m.entries.length) {
    const tr = el("tr");
    const td = el("td", "No models yet.");
    td.colSpan = 7;
    tr.append(td);
    body.append(tr);
  }
  m.entries.forEach((e) => {
    const tr = el("tr");
    const name = el("td");
    name.append(el("strong", e.label));
    if (e.source === "env") name.append(el("div", "from Cloudflare secret", "muted small"));
    const model = el("td", e.model);
    const key = el("td", e.keyHint);
    const today = el("td", `${fmt(e.usedToday)} / ${fmt(e.rpd)}`);
    const bar = el("div", undefined, "bar");
    const fill = el("i");
    fill.style.width = `${Math.min(100, (e.usedToday / Math.max(1, e.rpd)) * 100)}%`;
    bar.append(fill);
    today.append(bar);
    const now = el("td", `${e.rpmNow} / ${e.rpm}`);
    const status = el("td");
    status.append(el("span", e.status === "cooling" ? `resting ${e.cooldownSec}s` : e.status, `tag ${e.status}`));
    if (e.lastError) status.append(el("div", e.lastError, "muted small"));
    const actions = el("td", undefined, "actions");
    const toggle = el("button", e.enabled ? "Switch off" : "Switch on", "btn ghost");
    toggle.type = "button";
    toggle.addEventListener("click", () => act(() => api("/api/admin/models", { method: "PUT", json: { id: e.id, patch: { enabled: !e.enabled } } })));
    const test = el("button", "Test", "btn secondary");
    test.type = "button";
    test.addEventListener("click", async () => {
      test.disabled = true;
      try {
        const r = await api("/api/admin/models/test", { method: "POST", json: { id: e.id } });
        toast(r.ok ? `${e.model} answered in ${r.ms} ms` : `Test failed: ${r.message}`);
      } catch (err) { toast(err.message); }
      test.disabled = false;
      load();
    });
    const limits = el("button", "Limits", "btn ghost");
    limits.type = "button";
    limits.addEventListener("click", () => {
      const rpm = prompt("Requests per minute for this model:", e.rpm);
      if (rpm === null) return;
      const rpd = prompt("Requests per day for this model:", e.rpd);
      if (rpd === null) return;
      act(() => api("/api/admin/models", { method: "PUT", json: { id: e.id, patch: { rpm: Number(rpm), rpd: Number(rpd) } } }));
    });
    actions.append(toggle, test, limits);
    if (e.source !== "env") {
      const del = el("button", "Remove", "btn ghost");
      del.type = "button";
      del.addEventListener("click", () => {
        if (confirm(`Remove ${e.label} (${e.model}) from the pool?`)) act(() => api("/api/admin/models", { method: "DELETE", json: { id: e.id } }));
      });
      actions.append(del);
    }
    tr.append(name, model, key, today, now, status, actions);
    body.append(tr);
  });

  const form = $("#form-settings");
  if (document.activeElement?.form !== form) {
    for (const [k, v] of Object.entries(m.settings)) {
      const input = form.elements[k];
      if (!input) continue;
      if (input.type === "checkbox") input.checked = Boolean(v);
      else input.value = v;
    }
  }

  const history = $("#history");
  history.innerHTML = "";
  const peak = Math.max(1, ...m.history.map((h) => h.total));
  m.history.forEach((h) => {
    const col = el("div", undefined, `col${h.today ? " today" : ""}`);
    col.title = `${h.day}: ${h.total} requests, ${h.users} students, ${h.denied} turned away`;
    col.append(el("span", fmt(h.total)));
    const bar = el("i");
    bar.style.height = `${Math.max(3, (h.total / peak) * 100)}px`;
    col.append(bar, el("span", h.day.slice(5)));
    history.append(col);
  });
  const kinds = $("#kinds");
  kinds.innerHTML = "";
  const rows = Object.entries(m.kinds).sort((a, b) => b[1] - a[1]);
  if (!rows.length) kinds.append(el("li", "Nothing yet today.", "muted"));
  rows.forEach(([k, n]) => kinds.append(el("li", `${k}: ${fmt(n)}`)));
  $("#class-people").textContent = m.classes.active
    ? `In class: ${m.classes.active_names.join(", ")}${m.classes.waiting ? `. Waiting: ${m.classes.queue_names.join(", ")}` : ""}.`
    : "No one is in a live class right now.";

  const users = $("#users tbody");
  users.innerHTML = "";
  if (!m.perUser.length) {
    const tr = el("tr");
    const td = el("td", "No requests yet today.");
    td.colSpan = 2;
    tr.append(td);
    users.append(tr);
  }
  m.perUser.slice(0, 15).forEach((u) => {
    const tr = el("tr");
    tr.append(el("td", u.name), el("td", String(u.used)));
    users.append(tr);
  });
  const errors = $("#errors");
  errors.innerHTML = "";
  if (!m.errors.length) errors.append(el("li", "No problems recorded.", "muted"));
  m.errors.forEach((e) => errors.append(el("li", `${new Date(e.at).toLocaleTimeString()} · ${e.entryId || "—"} · ${e.message}`)));
}

function untilText(resetAt, now) {
  const ms = resetAt - now;
  const h = Math.floor(ms / 3600000);
  return `${h} h ${Math.round((ms % 3600000) / 60000)} min`;
}

async function load() {
  try {
    render(await api("/api/admin/monitor"));
  } catch (err) {
    toast(err.message);
  }
}

async function act(fn) {
  try {
    await fn();
    toast("Saved.");
  } catch (err) { toast(err.message); }
  load();
}

function showDash() {
  $("#login").hidden = true;
  $("#dash").hidden = false;
  load();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) load(); }, 8000);
}

$("#form-login").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/admin/login", { method: "POST", json: { secret: event.target.secret.value } });
    token = data.token;
    sessionStorage.setItem("sh_admin", token);
    event.target.reset();
    showDash();
  } catch (err) { toast(err.message); }
});

$("#form-add").addEventListener("submit", async (event) => {
  event.preventDefault();
  const f = event.target;
  const button = f.querySelector("button");
  button.disabled = true;
  try {
    const r = await api("/api/admin/models", {
      method: "POST",
      json: {
        label: f.label.value,
        key: f.key.value.trim(),
        models: f.models.value,
        rpm: Number(f.rpm.value),
        rpd: Number(f.rpd.value),
      },
    });
    toast(`Added ${r.added.length} model${r.added.length === 1 ? "" : "s"}. Use Test to check them.`);
    f.key.value = "";
    load();
  } catch (err) { toast(err.message); }
  button.disabled = false;
});

$("#form-settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  const f = event.target;
  const patch = {};
  for (const input of f.elements) {
    if (!input.name) continue;
    patch[input.name] = input.type === "checkbox" ? input.checked : Number(input.value);
  }
  act(() => api("/api/admin/settings", { method: "PUT", json: { patch } }));
});

$("#refresh").addEventListener("click", load);
$("#logout").addEventListener("click", signOut);

(async () => {
  try {
    const setup = await fetch("/api/setup").then((r) => r.json());
    if (!setup.admin) $("#login-note").textContent = "Admin is switched off. Add an ADMIN_SECRET secret (Cloudflare → Settings → Variables and Secrets), or ADMIN_SECRET in .dev.vars, then reload.";
  } catch { /* ignore */ }
  if (token) showDash();
})();
