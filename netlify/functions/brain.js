// Serves data/brain.json from the private repo to the dashboard.
// Token is server-side only (Netlify env var). Never sent to the browser.
// Optional privacy gate: if ACCESS_PASSWORD is set, the request must send a
// matching "x-access-password" header, otherwise the data is refused (401).
export async function handler(event) {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;   // "d-one-smarthomes/d-one-brain"
  const path  = process.env.BRAIN_PATH;    // "data/brain.json"
  const gate  = process.env.ACCESS_PASSWORD; // optional; if set, read requires it
 
  if (gate) {
    const h = (event && event.headers) || {};
    const pw = h["x-access-password"] || h["X-Access-Password"] || "";
    if (pw !== gate) {
      return { statusCode: 401, headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ error: "Password required" }) };
    }
  }
 
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.raw+json",
          "User-Agent": "d-one-brain-dashboard",
        },
      }
    );
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: "GitHub read failed", status: res.status }) };
    }
    const data = await res.text(); // raw file contents (JSON string)
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: data,
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
}
