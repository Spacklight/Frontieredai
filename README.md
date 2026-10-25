# Study Helper

An AI tutor that runs on **Cloudflare Workers**. The browser gets plain HTML, CSS, and JavaScript from the `ASSETS` binding. Accounts, outlines, and class records are JSON files in a GitHub repo. Gemini (`gemini-3.5-flash-lite`) teaches, reads uploads, and grades.

There is no Node server in production. `scripts/local-dev.mjs` only exists so you can try the same `worker.js` on a phone with Termux, where Wrangler's workerd binary often will not run.

## What you get

- Register and log in. Passwords are SHA-256 hashed with `crypto.subtle` (salted with the username) and never sent back to the browser.
- Profile: name, age, grade, subjects, exam date, study hours.
- Tutor chat, with your outline in the prompt.
- PDF / DOCX / image upload. Topics and subtopics are saved. The file itself is not.
- Live chalkboard class: 10–15 segments, SVG chalk drawings (circle, cycle, Venn, ruler, protractor), speech at rate `0.65`, English or Chichewa.
- Raise hand with `webkitSpeechRecognition`, or type.
- Weekly timetable from your study hours.
- Multiple-choice and essay exercises. The answer key stays in GitHub. You can also upload a photo or PDF of a written sheet to be graded.
- Vision page: exam countdown, learned topics, announcements.

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
| `GEMINI_API_KEY` | Key from [Google AI Studio](https://aistudio.google.com/apikey) |
| `GITHUB_TOKEN` | Fine-grained token, **Contents: Read and write**, this repo only |
| `AUTH_SECRET` | A long random string you invent |
| `GITHUB_OWNER` | Your GitHub username |
| `GITHUB_REPO` | `aidata` (or another repo name) |
| `GITHUB_BRANCH` | `main` |

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
npx wrangler deploy
```

`npm run dev` is Wrangler’s own dev server, if you are on a desktop where workerd runs. Termux should keep using `node scripts/local-dev.mjs`.

## Files

| File | Role |
| --- | --- |
| `worker.js` | The whole backend. `export default { fetch }` |
| `wrangler.jsonc` | Worker + `ASSETS` binding |
| `public/index.html` | Login, profile, desk, class |
| `public/styles.css` | White / indigo / purple UI, green chalkboard |
| `public/app.js` | Chat, timetable, exercises, chalk animation, speech |
| `public/vendor/marked.min.js` | Markdown in chat and on the board |

## API

`POST /api/auth/register` · `POST /api/auth/login` · `PUT /api/profile` · `POST /api/chat` · `POST /api/materials/upload` · `POST /api/classroom/start` · `POST /api/classroom/ask` · `POST /api/timetable/generate` · `POST /api/exercises/generate` · `POST /api/exercises/grade`

GitHub writes that the next click does not depend on (learned topics, the saved timetable, vision, the suggested next class) run inside `ctx.waitUntil` so the screen can update first. Register, profile, uploads, and exercise keys are saved before the response, so a refresh does not lose them.

Gemini 3.5 Flash-Lite is called **without** `temperature`, `topP`, or `topK`. Those fields are rejected by that model. JSON answers use `responseMimeType: application/json`, and if the API refuses that, the worker retries once without it.
