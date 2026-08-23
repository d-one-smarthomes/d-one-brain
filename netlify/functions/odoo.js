// netlify/functions/odoo.js
// D1 Brain — Odoo push doorman. POST only.
// Creates a record in Odoo for an action tagged "Odoo", in the right place.
//
// Body: {
//   password: "<ACCESS_PASSWORD>",
//   task: { title, context, dest, project, assignee, stage, deadline }
// }
//   dest: "Project" | "CRM" | "Sales" | "Other"
//   project: Odoo project name (dest=Project/Other) or CRM sales team / pipeline (dest=CRM/Sales)
//
// Server-side env vars required (set in Netlify → Site settings → Environment):
//   ODOO_URL       e.g. https://d-one.odoo.com   (no trailing slash)
//   ODOO_DB        the Odoo database name
//   ODOO_USERNAME  the login email of the API user
//   ODOO_API_KEY   an Odoo API key (Preferences → Account Security → New API Key)
//
// The Odoo credentials never leave the server. Returns { ok, id, model }.

const ODOO_URL = (process.env.ODOO_URL || "").replace(/\/+$/, "");
const ODOO_DB = process.env.ODOO_DB || "";
const ODOO_USER = process.env.ODOO_USERNAME || "";
const ODOO_KEY = process.env.ODOO_API_KEY || "";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return json(400, { ok: false, error: "Body must be JSON" }); }

  const supplied =
    payload.password ||
    event.headers["x-access-password"] ||
    event.headers["X-Access-Password"];
  if (!process.env.ACCESS_PASSWORD || supplied !== process.env.ACCESS_PASSWORD) {
    return json(401, { ok: false, error: "Unauthorized" });
  }

  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_KEY) {
    return json(500, {
      ok: false,
      error: "Odoo is not configured on the server yet. Set ODOO_URL, ODOO_DB, ODOO_USERNAME and ODOO_API_KEY in Netlify.",
    });
  }

  const t = payload.task || {};
  const title = (t.title || "").trim();
  if (!title) return json(400, { ok: false, error: "Action has no title" });
  const dest = t.dest || "Project";

  try {
    const uid = await login();
    if (!uid) return json(502, { ok: false, error: "Odoo login failed — check ODOO_USERNAME / ODOO_API_KEY" });

    const userId = t.assignee ? await findId(uid, "res.users", [["name", "ilike", t.assignee]]) : null;
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(t.deadline || "") ? t.deadline : false;

    let model, values;
    if (dest === "CRM" || dest === "Sales") {
      model = "crm.lead";
      const teamId = t.project ? await findId(uid, "crm.team", [["name", "ilike", t.project]]) : null;
      const stageId = t.stage ? await findId(uid, "crm.stage", [["name", "ilike", t.stage]]) : null;
      values = clean({
        name: title,
        description: t.context || "",
        type: dest === "Sales" ? "opportunity" : "lead",
        user_id: userId || false,
        team_id: teamId || false,
        stage_id: stageId || false,
        date_deadline: deadline,
      });
    } else {
      // Project / Other → a project task
      model = "project.task";
      const projectId = t.project ? await findId(uid, "project.project", [["name", "ilike", t.project]]) : null;
      if (t.project && !projectId) {
        return json(422, { ok: false, error: `No Odoo project matching "${t.project}". Check the exact project name.` });
      }
      const stageId = t.stage ? await findId(uid, "project.task.type", [["name", "ilike", t.stage]]) : null;
      values = clean({
        name: title,
        description: t.context || "",
        project_id: projectId || false,
        date_deadline: deadline,
        stage_id: stageId || false,
      });
      if (userId) values.user_ids = [[6, 0, [userId]]]; // Odoo 15+ many2many assignees
    }

    let id;
    try {
      id = await create(uid, model, values);
    } catch (e) {
      // Fallback for older Odoo where project.task uses user_id (many2one)
      if (model === "project.task" && userId && /user_ids/.test(String(e))) {
        delete values.user_ids;
        values.user_id = userId;
        id = await create(uid, model, values);
      } else {
        throw e;
      }
    }

    return json(200, { ok: true, id, model });
  } catch (e) {
    return json(502, { ok: false, error: "Odoo error: " + String(e.message || e) });
  }
};

// ---- Odoo JSON-RPC helpers ----
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
function login() {
  return rpc("common", "login", [ODOO_DB, ODOO_USER, ODOO_KEY]);
}
function execKw(uid, model, method, args, kwargs) {
  return rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs || {}]);
}
async function findId(uid, model, domain) {
  const ids = await execKw(uid, model, "search", [domain], { limit: 1 });
  return ids && ids.length ? ids[0] : null;
}
function create(uid, model, values) {
  return execKw(uid, model, "create", [values]);
}
function clean(o) {
  const out = {};
  for (const k in o) { const v = o[k]; if (v !== "" && v !== null && v !== undefined) out[k] = v; }
  return out;
}
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
