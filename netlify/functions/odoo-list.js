// netlify/functions/odoo-list.js
// D1 Brain — Odoo READ doorman. GET only.  (diagnostic build)
// Returns the current API user's open Odoo project tasks; on failure it
// returns rich diagnostics in the body so we can see exactly what Odoo says.
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
 
  const config = {
    hasUrl: !!ODOO_URL, hasDb: !!ODOO_DB, hasUser: !!ODOO_USER, hasKey: !!ODOO_KEY,
    urlHost: hostOf(ODOO_URL), dbLen: ODOO_DB.length, keyLen: ODOO_KEY.length,
    userMasked: mask(ODOO_USER),
  };
  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_KEY) {
    return json({ ok: false, stage: "config", error: "Missing a required env var", config });
  }
 
  // 1) Try to log in normally.
  let uid = null, loginErr = null, authErr = null;
  try { uid = await login(); } catch (e) { loginErr = String(e.message || e); }
 
  // 2) If login gave nothing, gather diagnostics before giving up.
  if (!uid) {
    const diag = { config };
    try { diag.version = await rpc("common", "version", []); }
    catch (e) { diag.versionError = String(e.message || e); }
 
    // authenticate() is the modern equivalent of login(); try it too.
    try { uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_USER, ODOO_KEY, {}]); }
    catch (e) { authErr = String(e.message || e); }
 
    if (!uid) {
      try { diag.databases = await rpc("db", "list", []); }
      catch (e) { diag.dbListError = String(e.message || e); }
      return json({ ok: false, stage: "login", loginError: loginErr, authError: authErr,
        note: "Odoo rejected the DB+user+key. Check ODOO_DB matches one of `databases` (if shown), and that ODOO_API_KEY is a valid key for this user.",
        ...diag });
    }
  }
 
  // 3) Read this user's open project tasks
  const fields = ["id", "name", "date_deadline", "stage_id", "project_id", "kanban_state", "priority"];
  try {
    const rows = await tryReads(uid, fields);
    const tasks = (rows || []).map((r) => ({
      id: r.id, name: r.name || "", deadline: r.date_deadline || null,
      stage: nameOf(r.stage_id), stageId: idOf(r.stage_id),
      project: nameOf(r.project_id), projectId: idOf(r.project_id),
      kanban: r.kanban_state || "normal", priority: r.priority || "0",
    }));
    return json({ ok: true, uid, count: tasks.length, tasks });
  } catch (e) {
    return json({ ok: false, stage: "read", uid, error: String(e.message || e), config });
  }
};
 
async function tryReads(uid, fields) {
  const openFold = ["stage_id.fold", "=", false];
  const attempts = [
    [["user_ids", "in", [uid]], openFold],
    [["user_ids", "in", [uid]]],
    [["user_id", "=", uid], openFold],
    [["user_id", "=", uid]],
  ];
  let lastErr;
  for (const domain of attempts) {
    try {
      return await execKw(uid, "project.task", "search_read", [domain], {
        fields, limit: 100, order: "date_deadline asc, priority desc, id desc",
      });
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Could not read project.task");
}
 
function nameOf(m2o) { return Array.isArray(m2o) ? m2o[1] : ""; }
function idOf(m2o) { return Array.isArray(m2o) ? m2o[0] : null; }
function hostOf(u) { try { return new URL(u).host; } catch { return ""; } }
function mask(s) { if (!s) return ""; const [a, b] = String(s).split("@"); return (a ? a.slice(0, 2) + "***" : "") + (b ? "@" + b : ""); }
 
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
 
