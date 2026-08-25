// netlify/functions/odoo-list.js
// D1 Brain — Odoo READ doorman. GET only.
// Returns the current API user's open Odoo project tasks so the brain can
// show and manage them. Non-destructive: only reads.
//
// Auth: header  x-access-password: <ACCESS_PASSWORD>   (or ?pw= as fallback)
//
// Server-side env vars (same as odoo.js):
//   ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY
// The Odoo credentials never leave the server. Returns { ok, uid, count, tasks }.

const ODOO_URL = (process.env.ODOO_URL || "").replace(/\/+$/, "");
const ODOO_DB = process.env.ODOO_DB || "";
const ODOO_USER = process.env.ODOO_USERNAME || "";
const ODOO_KEY = process.env.ODOO_API_KEY || "";

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed" });

  const supplied =
    event.headers["x-access-password"] ||
    event.headers["X-Access-Password"] ||
    (event.queryStringParameters && event.queryStringParameters.pw);
  if (!process.env.ACCESS_PASSWORD || supplied !== process.env.ACCESS_PASSWORD) {
    return json(401, { ok: false, error: "Unauthorized" });
  }

  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_KEY) {
    return json(500, {
      ok: false,
      error: "Odoo is not configured on the server yet. Set ODOO_URL, ODOO_DB, ODOO_USERNAME and ODOO_API_KEY in Netlify.",
    });
  }

  try {
    const uid = await login();
    if (!uid) return json(502, { ok: false, error: "Odoo login failed — check ODOO_USERNAME / ODOO_API_KEY" });

    const fields = ["id", "name", "date_deadline", "stage_id", "project_id", "kanban_state", "priority"];

    // "Assigned to me": modern Odoo uses user_ids (m2m); older uses user_id (m2o).
    // "Open": exclude tasks sitting in a folded (Done/closed) stage. Both are
    // tried defensively so this works across Odoo versions.
    let rows = await tryReads(uid, fields);

    const tasks = (rows || []).map((r) => ({
      id: r.id,
      name: r.name || "",
      deadline: r.date_deadline || null,
      stage: nameOf(r.stage_id),
      stageId: idOf(r.stage_id),
      project: nameOf(r.project_id),
      projectId: idOf(r.project_id),
      kanban: r.kanban_state || "normal", // normal | done | blocked
      priority: r.priority || "0",
    }));

    return json(200, { ok: true, uid, count: tasks.length, tasks });
  } catch (e) {
    return json(502, { ok: false, error: "Odoo error: " + String(e.message || e) });
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

// ---- Odoo JSON-RPC helpers (same shape as odoo.js) ----
async function rpc(service, method, args) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }),
  });
  const j = await res.json();
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
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
