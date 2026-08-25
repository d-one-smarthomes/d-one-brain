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
  const fields = ["id", "name", "date_deadline", "stage_id", "project_id", "priority"];
  const domain = [["user_ids", "in", [uid]]];
 
  try {
    const rows = await execKw(uid, "project.task", "search_read", [domain], {
      fields, limit: 100, order: "date_deadline asc, priority desc, id desc",
    });
    const tasks = (rows || []).map((r) => ({
      id: r.id,
      name: r.name || "",
      deadline: r.date_deadline || null,
      stage: nameOf(r.stage_id),
      stageId: idOf(r.stage_id),
      project: nameOf(r.project_id),
      projectId: idOf(r.project_id),
      priority: r.priority || "0",
    }));
    return json({ ok: true, uid, count: tasks.length, tasks });
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
 
