// Writes data/brain.json back to the private repo — in-place commit, full history.
// Token stays server-side (Netlify env var).
// Optional privacy gate: if ACCESS_PASSWORD (or legacy EDIT_PASSWORD) is set, the
// request must send the matching password (via "x-access-password" header or
// {"password": "..."} in the body), otherwise the write is refused (401).
export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;   // "d-one-smarthomes/d-one-brain"
  const path  = process.env.BRAIN_PATH;    // "data/brain.json"
  const gate  = process.env.ACCESS_PASSWORD || process.env.EDIT_PASSWORD; // optional
 
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Bad JSON body" }) }; }
 
  if (gate) {
    const h = (event && event.headers) || {};
    const pw = h["x-access-password"] || h["X-Access-Password"] || body.password || "";
    if (pw !== gate) {
      return { statusCode: 401, body: JSON.stringify({ error: "Bad or missing password" }) };
    }
  }
  if (!body.data || typeof body.data !== "object") {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing data object" }) };
  }
 
  const api = `https://api.github.com/repos/${repo}/contents/${path}`;
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "d-one-brain-dashboard",
  };
 
  try {
    // Get the current file's sha for an in-place commit (never a blind overwrite).
    const cur = await fetch(api, { headers: ghHeaders });
    let sha;
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
    } else if (cur.status !== 404) {
      const t = await cur.text();
      return { statusCode: cur.status, body: JSON.stringify({ error: "Could not read current file", detail: t }) };
    }
 
    const content = JSON.stringify(body.data, null, 2) + "\n";
    const b64 = Buffer.from(content, "utf8").toString("base64");
 
    const put = await fetch(api, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: (body.message || "Update brain via dashboard").slice(0, 200),
        content: b64,
        sha, // omitted when creating the file for the first time
      }),
    });
    if (!put.ok) {
      const t = await put.text();
      return { statusCode: put.status, body: JSON.stringify({ error: "Commit failed", detail: t }) };
    }
    const res = await put.json();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, commit: res.commit && res.commit.sha }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
}
