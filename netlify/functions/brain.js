// Serves data/brain.json from the private repo to the dashboard.
// Token is server-side only (Netlify env var). Never sent to the browser.
export async function handler() {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;   // "d-one-smarthomes/d-one-brain"
  const path  = process.env.BRAIN_PATH;    // "data/brain.json"

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
