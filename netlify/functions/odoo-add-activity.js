// netlify/functions/odoo-add-activity.js
// D1 Brain — Odoo WRITE doorman. POST only.
// Creates a new mail.activity (To-Do) attached to a project.project record,
// found by name (ilike). Falls back to project.task if a task name is given
// instead. This is the "add an activity in project X" endpoint.
//
// Body: {
//   password: "<ACCESS_PASSWORD>",
//   project: "<project name, e.g. 'Yazbek'>",   // required unless taskId given
//   taskId: <project.task id>,                    // optional alt target
//   summary: "<short title>",                     // required
//   note: "<plain text detail>",                  // optional
//   due: "YYYY-MM-DD",                             // required
//   assignee: "<name>",                            // optional, defaults to API user
// }
// Returns HTTP 200 with { ok, activityId, resModel, resId, resName } or { ok:false, error }.
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

  const summary = String(payload.summary || "").trim();
  if (!summary) return json({ ok: false, error: "Missing summary" });
  const due = normDeadlineDate(payload.due);
  if (!due) return json({ ok: false, error: "Missing/invalid due date (YYYY-MM-DD)" });

  let uid = null;
  try { uid = await login(); } catch (e) {}
  if (!uid) { try { uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_USER, ODOO_KEY, {}]); } catch (e) {} }
  if (!uid) return json({ ok: false, error: "Odoo login failed" });

  // Resolve target record: explicit taskId, or search project.project by name.
  let resModel = null, resId = null, resName = null;
  try {
    if (payload.taskId) {
      const rows = await execKw(uid, "project.task", "read", [[Number(payload.taskId)]], { fields: ["name"] });
      if (!rows || !rows[0]) return json({ ok: false, error: `No project.task with id ${payload.taskId}` });
      resModel = "project.task"; resId = rows[0].id; resName = rows[0].name;
    } else {
      const name = String(payload.project || "").trim();
      if (!name) return json({ ok: false, error: "Missing project (name) or taskId" });
      const found = await execKw(uid, "project.project", "search_read", [[["name", "ilike", name]]], { fields: ["name"], limit: 5 });
      if (!found || !found.length) return json({ ok: false, error: `No project matching "${name}"` });
      if (found.length > 1) return json({ ok: false, error: `Multiple projects matching "${name}"`, matches: found.map(f => ({ id: f.id, name: f.name })) });
      resModel = "project.project"; resId = found[0].id; resName = found[0].name;
    }
  } catch (e) {
    return json({ ok: false, error: "Lookup failed: " + String(e.message || e) });
  }

  // Resolve assignee (defaults to the API user itself).
  let userId = uid;
  if (payload.assignee) {
    const nm = String(payload.assignee).trim();
    try {
      const found = await execKw(uid, "res.users", "search", [[["name", "ilike", nm]]], { limit: 1 });
      if (!found || !found[0]) return json({ ok: false, error: `No Odoo user matching "${nm}"` });
      userId = found[0];
    } catch (e) {
      return json({ ok: false, error: "Assignee lookup failed: " + String(e.message || e) });
    }
  }

  // Resolve the "To-Do" activity type id (mail.activity.type).
  let activityTypeId = null;
  try {
    const types = await execKw(uid, "mail.activity.type", "search", [[["name", "ilike", "To-Do"]]], { limit: 1 });
    activityTypeId = types && types[0] ? types[0] : null;
  } catch (e) { /* leave null — Odoo will use its default if allowed */ }

  const vals = {
    res_model: resModel,
    res_id: resId,
    summary: summary,
    date_deadline: due,
    user_id: userId,
  };
  if (activityTypeId) vals.activity_type_id = activityTypeId;
  if (payload.note) vals.note = "<p>" + escapeHtml(String(payload.note)).replace(/\n/g, "<br>") + "</p>";

  try {
    const newId = await execKw(uid, "mail.activity", "create", [vals]);
    return json({ ok: true, activityId: newId, resModel, resId, resName, due, userId });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e), attempted: vals });
  }
};

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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
