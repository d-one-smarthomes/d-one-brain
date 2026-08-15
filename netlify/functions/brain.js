// netlify/functions/brain.js
// D1 Brain — READ doorman. GET only. Returns the full brain.json object.
// Auth: header  x-access-password: <ACCESS_PASSWORD>
// The GitHub token never leaves the server.

const OWNER  = process.env.BRAIN_OWNER  || "d-one-smarthomes";
const REPO   = process.env.BRAIN_REPO   || "d-one-brain";
const PATH   = process.env.BRAIN_PATH   || "data/brain.json";
const BRANCH = process.env.BRAIN_BRANCH || "main";

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const supplied =
    event.headers["x-access-password"] || event.headers["X-Access-Password"];
  if (!process.env.ACCESS_PASSWORD || supplied !== process.env.ACCESS_PASSWORD) {
    return json(401, { ok: false, error: "Unauthorized" });
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${BRANCH}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "d1brain-doorman",
        },
      }
    );

    if (!res.ok) {
      return json(res.status, {
        ok: false,
        error: "GitHub read failed",
        detail: await res.text(),
      });
    }

    const file = await res.json();
    const content = Buffer.from(file.content, "base64").toString("utf8");

    // Body = the full brain object (as text). sha returned in a header
    // in case a client wants it; save.js re-reads it itself, so callers
    // don't have to.
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "x-brain-sha": file.sha,
      },
      body: content,
    };
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
