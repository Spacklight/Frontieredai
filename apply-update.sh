#!/bin/sh
# Run once, from inside the study-helper folder, after unzipping the update over it.
# Adds the coordinator (Durable Object) to wrangler.jsonc without touching your other settings.
set -e
node -e '
const fs = require("fs");
let s = fs.readFileSync("wrangler.jsonc", "utf8");
if (s.includes("\"COORD\"")) { console.log("wrangler.jsonc already has the COORD binding."); process.exit(0); }
const add = "\n  \"durable_objects\": { \"bindings\": [{ \"name\": \"COORD\", \"class_name\": \"Coordinator\" }] },\n  \"migrations\": [{ \"tag\": \"v1\", \"new_sqlite_classes\": [\"Coordinator\"] }],";
const next = s.replace(/("main"\s*:\s*"worker\.js",)/, "$1" + add);
if (next === s) { console.error("Could not find \"main\": \"worker.js\" in wrangler.jsonc. Add the COORD block by hand (see README)."); process.exit(1); }
fs.writeFileSync("wrangler.jsonc", next);
console.log("wrangler.jsonc updated with the COORD binding.");
'
