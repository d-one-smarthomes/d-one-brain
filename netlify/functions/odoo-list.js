// netlify/functions/odoo-list.js
// D1 Brain — Odoo READ doorman. GET only.
// Returns the current API user's open Odoo project tasks so the brain can
// show and manage them. Non-destructive: only reads.
//
// Auth: header  x-access-password: <ACCESS_PASSWORD>   (or ?pw= as fallback)
//
// NOTE: This endpoint returns HTTP 200 even on failure, with { ok:false, ... }
// in the body, so the dashboard (and debugging) can always read the reason.
//
// Server-side env vars (same as odoo.js):
//   ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY

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

  // Which config values are present (never echo the secret values themselves).
  const config = {
    hasUrl: !!ODOO_URL,
    hasDb: !!ODOO_DB,
    hasUser: !!ODOO_USER,
    hasKey: !!ODOO_KEY,
    urlHost: hostOf(ODOO_URL),
    dbLen: ODOO_DB.length,
    userMasked: mask(ODOO_USER),
  };

  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_KEY) {
    return json({ ok: false, stage: "config", error: "Missing one of ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_API_KEY", config });
  }

  // 1) Log in
  let uid;
  try {
    uid = await login();
  } catch (e) {
    return json({ ok: false, stage: "login", error: String(e.message || e), config });
  }
  if (!uid) {
    return json({ ok: false, stage: "login", error: "Login returned no uid — check ODOO_DB name, ODOO_USERNAME and ODOO_API_KEY", config });
  }

  // 2) Read this user's open project tasks
  const fields = ["id", "name", "date_deadline", "stage_id", "project_id", "kanban_state", "priority"];
  try {
    const rows = await tryReads(uid, fields);
    const tasks = (rows || []).map((r) => ({
      id: r.id,
      name: r.name || "",
      deadline: r.date_deadline || null,
      stage: nameOf(r.stage_id),
      stageId: idOf(r.stage_id),
      project: nameOf(r.project_id),
      projectId: idOf(r.project_id),
      kanban: r.kanban_state || "normal",
      priority: r.priority || "0",
    }));
    return json({ ok: true, uid, count: tasks.length, tasks });
  } catch (e) {
    return json({ ok: false, stage: "read", uid, error: String(e.message || e), config });
  }
};

// Try the most modern domain first, then fall back for older Odoo schemas.
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
        fields,
        limit: 100,
        order: "date_deadline asc, priority desc, id desc",
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Could not read project.task");
}

function nameOf(m2o) { return Array.isArray(m2o) ? m2o[1] : ""; }
function idOf(m2o) { return Array.isArray(m2o) ? m2o[0] : null; }
function hostOf(u) { try { return new URL(u).host; } catch { return ""; } }
function mask(s) { if (!s) return ""; const [a, b] = String(s).split("@"); return (a ? a.slice(0, 2) + "***" : "") + (b ? "@" + b : ""); }

// ---- Odoo JSON-RPC helpers ----
async function rpc(service, method, args) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error(`Non-JSON reply from Odoo (HTTP ${res.status}): ${text.slice(0, 160)}`); }
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
