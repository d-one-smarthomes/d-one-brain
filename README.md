# D-One Central Brain

Single source of truth for Darren's priorities and tasks. Canonical data: `data/brain.json`.
Dashboard: hosted on Netlify, reads this file live via a serverless function, and writes back via a second function.

## How Claude edits this
1. READ current file via GitHub Contents API (get content + `sha`).
2. Modify the JSON. Keep the schema. Update `meta.updated` to today's date.
3. WRITE back via the Contents API using the retrieved `sha` (in-place commit — never a blind overwrite).
4. Commit message = plain English of the change (e.g. "Add task: call plumber; move DB skill to parking lot").

## Dashboard editing (v2)
- `public/index.html` is fully editable: tap text to edit, tick to complete, +/× to add/remove, Save to commit.
- `netlify/functions/brain.js` reads the file; `netlify/functions/save.js` writes it back (commit per save).
- Set `EDIT_PASSWORD` in Netlify to require a password before saving.

## Rules
- `weeklyFocus.three` holds a MAXIMUM of 3. If adding a 4th, ask Darren what drops.
- New items pass The One Filter before earning a place.
- Every task/item should have an owner where possible (see `delegation`).
- Never delete history by force-pushing. Every change is a normal commit.
- Tasks tags (pick from): self, marriage, family, home, d-one, finance, adventure, social, ideas.

## Schema
See `data/brain.json`. Top-level keys: meta, oneFilter, weeklyFocus, areas, delegation,
salesJourney, monthlyGoal, tasks, energyLog, parkingLot.

## Odoo two-way sync (functions)
- `netlify/functions/odoo-list.js` — GET, returns the API user's open Odoo project tasks (read).
- `netlify/functions/odoo-update.js` — POST, updates a task: `done` (complete/reopen via task `state`), `deadline` (date/datetime or "" to clear), `stageId`. Auth by `ACCESS_PASSWORD`; Odoo creds stay server-side (`ODOO_URL/DB/USERNAME/API_KEY`).
