// netlify/functions/odoo-list.js
// D1 Brain — Odoo READ doorman. GET only.  (Odoo 19 build)
// Reads the current API user's open project tasks. On read failure it also
// returns the project.task field list so the query can be corrected.
//
// Auth: header  x-access-password: <ACCESS_PASSWORD>   (or ?pw= as fallback)
// Env: ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY
 
const ODOO_URL = (process.env.ODOO_URL || "").replace(/\/+$/, "");
const ODOO_DB = process.env.ODOO_DB || "";
const ODOO_USER = process.env.ODOO_USERNAME || "";
const ODOO_KEY = process.env.ODOO_API_KEY || "";
 
exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json({ ok: false, error: "Method not allowed" });
 
  const supplied =
    event.headers["x-access-password"] ||
    event.headers["X-Access-Password"] ||
    (event.queryStringParameters && event.queryStringParameters.pw);
  if (!process.env.ACCESS_PASSWORD || supplied !== process.env.ACCESS_PASSWORD) {
    return json({ ok: false, error: "Unauthorized" });
  }
  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_KEY) {
    return json({ ok: false, stage: "config", error: "Missing a required env var" });
  }
 
  // Authenticate (login works; keep authenticate as a fallback).
  let uid = null;
  try { uid = await login(); } catch (e) {}
  if (!uid) { try { uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_USER, ODOO_KEY, {}]); } catch (e) {} }
  if (!uid) return json({ ok: false, stage: "login", error: "Odoo rejected the DB+user+key" });
 
  // Odoo 19: assignee is user_ids (m2m). Ask only for fields that exist.
  const fields = ["id", "name", "date_deadline", "stage_id", "project_id", "priority", "description", "user_ids"];

  try {
    // Discover which `state` values mean "closed" (done/cancelled) so we
    // never re-show a task that was just completed from here. Computed
    // dynamically since the exact selection keys vary by Odoo version.
    const closedStates = await closedStateKeys(uid);
    const domain = [["user_ids", "in", [uid]]];
    if (closedStates.length) domain.push(["state", "not in", closedStates]);

    const rows = await execKw(uid, "project.task", "search_read", [domain], {
      fields, limit: 100, order: "date_deadline asc, priority desc, id desc",
    });

    // user_ids comes back as an array of ints (m2m) — resolve to names in
    // one batched call rather than N+1 lookups.
    const allUserIds = Array.from(new Set([].concat(...(rows || []).map((r) => r.user_ids || []))));
    let nameById = {};
    if (allUserIds.length) {
      const users = await execKw(uid, "res.users", "read", [allUserIds], { fields: ["name"] });
      (users || []).forEach((u) => { nameById[u.id] = u.name; });
    }

    const tasks = (rows || []).map((r) => ({
      id: r.id,
      name: r.name || "",
      deadline: r.date_deadline || null,
      stage: nameOf(r.stage_id),
      stageId: idOf(r.stage_id),
      project: nameOf(r.project_id),
      projectId: idOf(r.project_id),
      priority: r.priority || "0",
      note: stripHtml(r.description || ""),
      assignee: (r.user_ids || []).map((id) => nameById[id]).filter(Boolean).join(", "),
      url: recordUrl("project.task", r.id),
    }));

    // Activities scheduled for this user (mail.activity). These are the
    // "next action" nudges Odoo attaches to any record (a task, a lead, an
    // invoice…). They live only while pending — once marked done Odoo removes
    // them — so no closed-state filtering is needed. Fetched in its own
    // try/catch so an activity failure never breaks the task list.
    let activities = [];
    let activitiesError = null;
    try {
      activities = await listActivities(uid);
    } catch (e) {
      activitiesError = String(e.message || e);
    }

    return json({ ok: true, uid, count: tasks.length, tasks, activities, activitiesError });
  } catch (e) {
    // Read failed — return the schema so we can correct field names.
    let schemaFields = null, schemaError = null;
    try {
      const fg = await execKw(uid, "project.task", "fields_get", [], { attributes: ["type"] });
      schemaFields = Object.keys(fg || {}).sort();
    } catch (e2) { schemaError = String(e2.message || e2); }
    return json({ ok: false, stage: "read", uid, error: String(e.message || e), schemaFields, schemaError });
  }
};
 
function nameOf(m2o) { return Array.isArray(m2o) ? m2o[1] : ""; }
function idOf(m2o) { return Array.isArray(m2o) ? m2o[0] : null; }
function stripHtml(s) { return String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(); }

// Read the mail.activity records assigned to this user. Returns a normalised
// list the dashboard can render next to the tasks. `res_name` is the display
// name of the record the activity hangs off (e.g. the task or lead); if Odoo
// doesn't supply it we resolve it in one batched read per model.
async function listActivities(uid) {
  const fields = ["id", "summary", "activity_type_id", "date_deadline", "res_model", "res_id", "res_name", "note"];
  const rows = await execKw(uid, "mail.activity", "search_read", [[["user_id", "=", uid]]], {
    fields, limit: 100, order: "date_deadline asc, id asc",
  });

  // Resolve any missing res_name in batched reads grouped by model.
  const missing = {};
  (rows || []).forEach((r) => {
    if (!r.res_name && r.res_model && r.res_id) {
      (missing[r.res_model] = missing[r.res_model] || []).push(r.res_id);
    }
  });
  const resolved = {}; // "model:id" -> display name
  for (const model of Object.keys(missing)) {
    try {
      const recs = await execKw(uid, model, "read", [Array.from(new Set(missing[model]))], { fields: ["display_name"] });
      (recs || []).forEach((rec) => { resolved[model + ":" + rec.id] = rec.display_name; });
    } catch (e) { /* leave unresolved — still show the activity */ }
  }

  return (rows || []).map((r) => ({
    id: r.id,
    summary: (r.summary || "").trim(),
    type: nameOf(r.activity_type_id),
    deadline: r.date_deadline || null,
    resModel: r.res_model || "",
    resId: r.res_id || null,
    resName: r.res_name || resolved[r.res_model + ":" + r.res_id] || "",
    note: stripHtml(r.note || ""),
    // Activities have no standalone page — link to the record they hang off.
    url: (r.res_model && r.res_id) ? recordUrl(r.res_model, r.res_id) : "",
  }));
}

// Build an Odoo deep link to a record's form view. The generic /odoo/<model>/<id>
// path does not resolve in Odoo 19, but the backward-compatible /web# hash does.
function recordUrl(model, id) {
  if (!ODOO_URL || !model || !id) return "";
  return `${ODOO_URL}/web#id=${id}&model=${model}&view_type=form`;
}

// Ask Odoo which `state` selection keys mean done/cancelled, so completed
// tasks are excluded from the list instead of reappearing on refresh.
async function closedStateKeys(uid) {
  try {
    const fg = await execKw(uid, "project.task", "fields_get", [["state"]], { attributes: ["selection"] });
    const sel = (fg && fg.state && fg.state.selection) || [];
    return sel.filter(([k, l]) => /done|cancel|closed/i.test(k + " " + l)).map(([k]) => k);
  } catch (e) {
    return []; // If discovery fails, fall back to showing everything (old behaviour).
  }
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
 
