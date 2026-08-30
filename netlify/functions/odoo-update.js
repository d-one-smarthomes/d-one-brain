// netlify/functions/odoo-update.js
// D1 Brain — Odoo WRITE doorman. POST only.
// Updates an existing Odoo project.task: complete/reopen, reschedule the
// deadline, or move stage. The other half of two-way sync (odoo-list reads).
//
// Body: {
//   password: "<ACCESS_PASSWORD>",
//   id: <project.task id>,          // required
//   done: true | false,             // optional — complete / reopen
//   deadline: "YYYY-MM-DD" | "YYYY-MM-DD HH:MM:SS" | null,  // optional
//   stageId: <project.task.type id> // optional
//   note: "<plain text>",           // optional — replaces the task description
//   assignee: "<name>" | null,      // optional — resolves by name to res.users, replaces assignees
// }
// Returns HTTP 200 with { ok, id, wrote } or { ok:false, error }.
//
// Env: ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY
 
const ODOO_URL = (process.env.ODOO_URL || "").replace(/\/+$/, "");
const ODOO_DB = process.env.ODOO_DB || "";
const ODOO_USER = process.env.ODOO_USERNAME || "";
const ODOO_KEY = process.env.ODOO_API_KEY || "";
 
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json({ ok: false, error: "Method not allowed" });
 
  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return json({ ok: false, error: "Body must be JSON" }); }
 
  const supplied =
    payload.password ||
    event.headers["x-access-password"] ||
    event.headers["X-Access-Password"];
  if (!process.env.ACCESS_PASSWORD || supplied !== process.env.ACCESS_PASSWORD) {
    return json({ ok: false, error: "Unauthorized" });
  }
  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_KEY) {
    return json({ ok: false, error: "Odoo not configured (env vars)" });
  }
 
  const id = Number(payload.id);
  if (!id) return json({ ok: false, error: "Missing task id" });
 
  let uid = null;
  try { uid = await login(); } catch (e) {}
  if (!uid) { try { uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_USER, ODOO_KEY, {}]); } catch (e) {} }
  if (!uid) return json({ ok: false, error: "Odoo login failed" });

  // ---- mail.activity branch ----
  // Activities are a different model from project.task. Completing one uses
  // action_feedback (marks done, logs a note on the record, then removes the
  // activity); rescheduling writes date_deadline.
  if (payload.kind === "activity") {
    try {
      if (payload.done === true) {
        await execKw(uid, "mail.activity", "action_feedback", [[id]], { feedback: "Done via D1 Brain" });
        return json({ ok: true, id, kind: "activity", done: true });
      }
      if (Object.prototype.hasOwnProperty.call(payload, "deadline")) {
        const dl = normDeadlineDate(payload.deadline);
        if (!dl) return json({ ok: false, id, error: "Activity needs a valid deadline date" });
        await execKw(uid, "mail.activity", "write", [[id], { date_deadline: dl }]);
        return json({ ok: true, id, kind: "activity", wrote: { date_deadline: dl } });
      }
      return json({ ok: false, id, error: "Nothing to update on activity" });
    } catch (e) {
      return json({ ok: false, id, kind: "activity", error: String(e.message || e) });
    }
  }
 
  const vals = {};
 
  // Deadline: date or datetime, or null to clear.
  if (Object.prototype.hasOwnProperty.call(payload, "deadline")) {
    vals.date_deadline = normDeadline(payload.deadline);
  }
 
  // Stage move.
  if (payload.stageId) vals.stage_id = Number(payload.stageId);

  // Note / description — plain text in, wrapped for Odoo's HTML field.
  if (Object.prototype.hasOwnProperty.call(payload, "note")) {
    const t = String(payload.note || "").trim();
    vals.description = t ? "<p>" + escapeHtml(t).replace(/\n/g, "<br>") + "</p>" : false;
  }

  // Assignee — resolve a name to a res.users id and replace the assignee(s).
  if (Object.prototype.hasOwnProperty.call(payload, "assignee")) {
    const name = String(payload.assignee || "").trim();
    if (!name) {
      vals.user_ids = [[5, 0, 0]]; // clear all assignees (Odoo 15+ m2m)
    } else {
      let found = null;
      try { found = await execKw(uid, "res.users", "search", [[["name", "ilike", name]]], { limit: 1 }); } catch (e) {}
      const userId = found && found[0];
      if (!userId) return json({ ok: false, id, error: `No Odoo user matching "${name}"` });
      vals.user_ids = [[6, 0, [userId]]];
    }
  }

  // Complete / reopen via the task `state` field (Odoo 17+). Discover the
  // exact selection key from this Odoo so we never hardcode the wrong value.
  if (typeof payload.done === "boolean") {
    try {
      const key = await stateKey(uid, payload.done ? /done/i : /progress|open|in.?progress/i, payload.done);
      if (key) vals.state = key;
    } catch (e) {
      return json({ ok: false, id, error: "Could not resolve task state: " + String(e.message || e) });
    }
  }
 
  if (!Object.keys(vals).length) return json({ ok: false, id, error: "Nothing to update" });
 
  try {
    await execKw(uid, "project.task", "write", [[id], vals]);
    return json({ ok: true, id, wrote: vals });
  } catch (e) {
    // Fallback for older Odoo where project.task uses user_id (many2one)
    // instead of user_ids (many2many).
    if (vals.user_ids && /user_ids/i.test(String(e.message || e))) {
      try {
        const retry = Object.assign({}, vals);
        delete retry.user_ids;
        const m2m = vals.user_ids;
        retry.user_id = (m2m[0][0] === 6 && m2m[0][2].length) ? m2m[0][2][0] : false;
        await execKw(uid, "project.task", "write", [[id], retry]);
        return json({ ok: true, id, wrote: retry });
      } catch (e2) {
        return json({ ok: false, id, error: String(e2.message || e2), attempted: vals });
      }
    }
    return json({ ok: false, id, error: String(e.message || e), attempted: vals });
  }
};

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
 
// Pick the state selection key. wantDone=true → the 'done' option; else the
// first "in progress / open" option.
async function stateKey(uid, rx, wantDone) {
  const fg = await execKw(uid, "project.task", "fields_get", [["state"]], { attributes: ["selection"] });
  const sel = (fg && fg.state && fg.state.selection) || [];
  // sel = [[key,label],...]
  let hit = sel.find(([k, l]) => rx.test(k) || rx.test(l));
  if (!hit && wantDone) hit = sel.find(([k, l]) => /1_done|done|closed|complete/i.test(k + " " + l));
  return hit ? hit[0] : null;
}
 
// Accept a plain date or a full datetime; empty/null clears the field.
// A date-only value gets a midday-UTC time so it can't roll to the wrong day
// in SAST (UTC+2).
function normDeadline(v) {
  if (v === null || v === undefined || v === "") return false;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + " 10:00:00";
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) return s.replace("T", " ") + (s.length === 16 ? ":00" : "");
  return false;
}
 
// mail.activity.date_deadline is a Date field (no time component). Accept a
// plain date or the date portion of a datetime; anything else is invalid.
function normDeadlineDate(v) {
  if (v === null || v === undefined || v === "") return false;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : false;
}

async function rpc(service, method, args) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error(`Non-JSON reply (HTTP ${res.status}): ${text.slice(0, 160)}`); }
  if (j.error) {
    const d = j.error.data || {};
    throw new Error(d.message || j.error.message || "RPC error");
  }
  return j.result;
}
function login() { return rpc("common", "login", [ODOO_DB, ODOO_USER, ODOO_KEY]); }
function execKw(uid, model, method, args, kwargs) {
  return rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs || {}]);
}
function json(obj) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
 
