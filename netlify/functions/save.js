// netlify/functions/save.js
// D1 Brain — WRITE doorman. POST only.
// Body: { "data": <full brain object>, "message": "<commit msg>", "password": "<ACCESS_PASSWORD>" }
// Commits the whole file back to GitHub as one normal commit. Full history kept.
// The GitHub token never leaves the server.

const OWNER  = process.env.BRAIN_OWNER  || "d-one-smarthomes";
const REPO   = process.env.BRAIN_REPO   || "d-one-brain";
const PATH   = process.env.BRAIN_PATH   || "data/brain.json";
const BRANCH = process.env.BRAIN_BRANCH || "main";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Body must be JSON" });
  }

  const { data, message, password } = payload;

  if (!process.env.ACCESS_PASSWORD || password !== process.env.ACCESS_PASSWORD) {
    return json(401, { ok: false, error: "Unauthorized" });
  }
  if (!data || typeof data !== "object") {
    return json(400, { ok: false, error: "Missing 'data' (must be the FULL brain object)" });
  }

  const gh = (path, init) =>
    fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "d1brain-doorman",
        ...(init && init.headers),
      },
    });

  try {
    // 1) Read the current file to get its sha (required to update it safely).
    const cur = await gh(`${PATH}?ref=${BRANCH}`, { method: "GET" });
    if (!cur.ok) {
      return json(cur.status, {
        ok: false,
        error: "Could not read current file",
        detail: await cur.text(),
      });
    }
    const { sha } = await cur.json();

    // 2) Write it back, pretty-printed so the diffs stay readable in GitHub.
    const content = Buffer.from(
      JSON.stringify(data, null, 2) + "\n",
      "utf8"
    ).toString("base64");

    const put = await gh(PATH, {
      method: "PUT",
      body: JSON.stringify({
        message: message || "D1Brain update",
        content,
        sha,
        branch: BRANCH,
      }),
    });

    if (!put.ok) {
      return json(put.status, {
        ok: false,
        error: "GitHub write failed",
        detail: await put.text(),
      });
    }

    const result = await put.json();
    return json(200, { ok: true, commit: result.commit && result.commit.sha });
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
