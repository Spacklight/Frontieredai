# Study Helper

An AI tutor that runs on **Cloudflare Workers**. The browser gets plain HTML, CSS, and JavaScript from the `ASSETS` binding. Accounts, outlines, and class records are JSON files in a GitHub repo. Gemini (`gemini-3.5-flash-lite`) teaches, reads uploads, and grades.

There is no Node server in production. `scripts/local-dev.mjs` only exists so you can try the same `worker.js` on a phone with Termux, where Wrangler's workerd binary often will not run.

## What you get

- **A teacher who decides.** Students never pick topics. After notes are uploaded the teacher plans the week, picks the next class, decides whether practice is needed (and how many questions, and which mix), and re-plans after every class and graded exercise.
- **Only the student's notes.** Every prompt carries a strict source rule and excerpts of the uploaded notes. The teacher refuses to teach until notes exist, and says so when something is not in them.
- **Profile for Malawi and beyond.** Level (primary, JCE, MSCE, college/university), examination board (MANEB, Cambridge, Edexcel, IB, TEVET, college-set exams, or any other), plus institution and programme for college students. The board only sets exam style, never content.
- **Uploads capped at 1 MB.** Bigger PDFs are split in the browser by halving the page range until every part is 1 MB or less; parts are merged back into one material. Photos are shrunk, text is chunked.
- **Daily limits that refresh at midnight (Malawi time).** Each student gets a fair share of the free-tier capacity. The share shrinks automatically when more students join, never below a floor, and classes, exercises and plans may use an extra allowance so studying is not blocked.
- **Key and model pool + admin dashboard** at `/admin.html`: add Google AI Studio keys and models, test them, set per-model limits, switch them on and off, and watch usage.
- **Platform monitor and class turns.** One coordinator sees every request. Requests go to the least busy key/model; a key that Google rate-limits rests automatically. Live classes have a limited number of seats; extra students wait in line and their class starts by itself.
- Live chalkboard class: SVG drawings, speech at rate `0.65`, English or Chichewa; raise hand by voice or typing.
- Exercises: multiple choice and essay, typed or handed in as a photo/PDF (1 MB). The answer key stays on the server.

## 1. Test in Termux

```bash
pkg update
pkg install nodejs git unzip
unzip study-helper.zip
cd study-helper
cp .dev.vars.example .dev.vars
nano .dev.vars
node scripts/local-dev.mjs
```

Node 20 or newer. Open `http://127.0.0.1:8080` in the phone browser.

Before accounts will save, the GitHub repo must exist and `.dev.vars` needs:

| Name | What it is |
| --- | --- |
| `GEMINI_API_KEY` | Key from [Google AI Studio](https://aistudio.google.com/apikey). It becomes the first entry of the pool; add more in the dashboard. |
| `GITHUB_TOKEN` | Fine-grained token, **Contents: Read and write**, this repo only |
| `AUTH_SECRET` | A long random string you invent |
| `GITHUB_OWNER` | Your GitHub username |
| `GITHUB_REPO` | `aidata` (or another repo name) |
| `GITHUB_BRANCH` | `main` |
| `ADMIN_SECRET` | Password for `/admin.html`. Without it the admin page is off. |
| `POOL_SECRET` | Optional. Encrypts keys added in the dashboard. Defaults to `AUTH_SECRET` — do not change it later or stored keys must be re-added. |

Create the GitHub repo first and let GitHub add a README, so the `main` branch exists. The worker creates `profiles.json`, `materials.json`, and `teacher-states.json` on first use.

`npm run check` runs a fake-GitHub self-test. It does not call Gemini or GitHub.

The sample chalkboard on the login screen does not need keys.

## 2. Push to GitHub

From a machine with git (Termux is fine):

```bash
cd study-helper
git init
git add .
git commit -m "Study Helper"
git branch -M main
git remote add origin https://github.com/YOUR_USER/study-helper.git
git push -u origin HEAD
```

Do not commit `.dev.vars`. It is listed in `.gitignore`.

The data repo (`aidata`) and the code repo can be two different repositories. The token must be allowed to write the **data** repo.

## 3. Cloudflare

1. Workers & Pages → Create → connect the **code** repo.
2. Framework preset: none. Build command can be empty. Deploy command: `npx wrangler deploy`.
3. In `wrangler.jsonc`, set `GITHUB_OWNER` and `GITHUB_REPO` under `vars` before you deploy (these are not secret).
4. Set secrets, either in the dashboard or with Wrangler:

```bash
npm install
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put AUTH_SECRET
npx wrangler secret put ADMIN_SECRET
npx wrangler deploy
```

`npm run dev` is Wrangler’s own dev server, if you are on a desktop where workerd runs. Termux should keep using `node scripts/local-dev.mjs`.


## 4. Admin dashboard, limits and class turns

Open `https://YOUR-WORKER.workers.dev/admin.html` and log in with `ADMIN_SECRET`.

- **The pool:** one row per key + model. Free tier is usually 15 requests/minute and 500/day per model, so each extra model or extra key adds that much capacity. Use **Test** after adding.
- **Per-student limit:** target (default 25 a day), floor (8), and auto-scale. With 450 usable requests a day and 30 students each gets 15; with 200 students everyone gets the floor and the pool may run dry earlier — the dashboard warns when expected demand is above capacity.
- **Seats:** a live class holds a seat while it plays (default 4 classes per key/model). When all seats are taken, students wait in line; they leave the line if they stop checking in for 45 seconds, and a class that goes silent for 90 seconds frees its seat.
- **Reserve:** 10% of daily capacity is kept back so lessons, plans, exercises and uploads still work after chat has stopped for the day.

The coordinator is a SQLite-backed Durable Object (`COORD` in `wrangler.jsonc`, included in Cloudflare's free plan). In Termux the same logic runs in-process and saves to `.local-coordinator.json`.

## Files

| File | Role |
| --- | --- |
| `worker.js` | Backend: accounts, teacher logic, prompts, admin API |
| `coordinator.js` | Key pool, limits, class turns, monitoring (Durable Object + local fallback) |
| `public/admin.html`, `admin.js`, `admin.css` | Admin dashboard |
| `public/vendor/pdf-lib.min.js` | In-browser PDF splitting (MIT) |
| `wrangler.jsonc` | Worker + `ASSETS` binding |
| `public/index.html` | Login, profile, desk, class |
| `public/styles.css` | White / indigo / purple UI, green chalkboard |
| `public/app.js` | Chat, timetable, exercises, chalk animation, speech |
| `public/vendor/marked.min.js` | Markdown in chat and on the board |

## API

Students: `POST /api/auth/register` · `POST /api/auth/login` · `GET /api/bootstrap` · `GET /api/quota` · `PUT /api/profile` · `POST /api/chat` · `POST /api/materials/upload` (≤ 1 MB per call) · `DELETE /api/materials` · `POST /api/teacher/plan` · `POST /api/classroom/start` (returns `202` with a queue position when seats are full) · `/heartbeat` · `/ask` · `/complete` · `/leave` · `POST /api/exercises/generate` · `POST /api/exercises/grade`

Admin (Bearer admin token from `POST /api/admin/login`): `GET /api/admin/monitor` · `POST|PUT|DELETE /api/admin/models` · `POST /api/admin/models/test` · `PUT /api/admin/settings`

Gemini is called **without** `temperature`, `topP`, or `topK` (rejected by Flash-Lite). JSON answers use `responseMimeType: application/json`, retried once without it if refused.
