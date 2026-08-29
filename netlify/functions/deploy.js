/ netlify/functions/deploy.js
// D1 Brain — CODE deploy doorman. POST only.
// Lets Claude (any session) commit code/config files to the repo without a token
// ever passing through the chat. Uses the server-side GITHUB_TOKEN already set
// in Netlify (the same one the `save` function uses for brain.json).
//
// Body: {
//   "path":     "public/index.html",     // repo-relative path
//   "content":  "<raw file text>",        // the full new file contents
//   "encoding": "utf8" | "base64",        // optional, default "utf8"
//   "message":  "commit message",         // optional
//   "password": "<DEPLOY_PASSWORD>"        // must match the Netlify env var
// }
// A code change here triggers a normal Netlify redeploy.
 
const OWNER  = process.env.BRAIN_OWNER  || "d-one-smarthomes";
const REPO   = process.env.BRAIN_REPO   || "d-one-brain";
const BRANCH = process.env.BRAIN_BRANCH || "main";
 
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
 
  let p;
  try {
    p = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Body must be JSON" });
  }
 
  const { path, content, encoding, message, password } = p;
 
  // --- auth ---
  if (!process.env.DEPLOY_PASSWORD || password !== process.env.DEPLOY_PASSWORD) {
    return json(401, { ok: false, error: "Unauthorized" });
  }
  if (!process.env.GITHUB_TOKEN) {
    return json(500, { ok: false, error: "Server missing GITHUB_TOKEN" });
  }
 
  // --- validate path (no traversal, no absolute, keep it in the repo) ---
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("..")) {
    return json(400, { ok: false, error: "Invalid 'path'" });
  }
  if (typeof content !== "string") {
    return json(400, { ok: false, error: "Missing 'content' (must be a string)" });
  }
 
  const b64 =
    encoding === "base64"
      ? content
      : Buffer.from(content, "utf8").toString("base64");
 
  const gh = (u, init) =>
    fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${u}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "d1brain-deploy",
        ...(init && init.headers),
      },
    });
 
  try {
    // 1) look up the current sha if the file already exists
    let sha;
    const cur = await gh(`${encodeURI(path)}?ref=${BRANCH}`, { method: "GET" });
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
    } else if (cur.status !== 404) {
      return json(cur.status, { ok: false, error: "Could not read current file", detail: await cur.text() });
    }
 
    // 2) write the file back (create or update)
    const put = await gh(encodeURI(path), {
      method: "PUT",
      body: JSON.stringify({
        message: message || `Deploy ${path} via Claude`,
        content: b64,
        sha, // undefined on first create — GitHub accepts that
        branch: BRANCH,
      }),
    });
 
    if (!put.ok) {
      return json(put.status, { ok: false, error: "GitHub write failed", detail: await put.text() });
    }
 
    const result = await put.json();
    return json(200, { ok: true, path, commit: result.commit && result.commit.sha });
  } catch (e) {
    return json(500, { ok: false, error: String(e) });
  }
};
 
function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
 
