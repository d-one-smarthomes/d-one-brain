// D1Brain MCP server — stateless Streamable-HTTP MCP endpoint for the Claude app / voice mode.
// Wraps the existing D1Brain Netlify data API (brain GET + save POST) as MCP tools so Claude
// can read and write Darren's Central Brain (data/brain.json) from any surface, including voice.
//
// Auth: a token must be supplied on every request, either as a query param (?k=TOKEN) or an
//   Authorization: Bearer TOKEN header. Set MCP_TOKEN in Netlify env to override the fallback.
// Data path: this function calls the sibling brain/save functions (server-to-server) using the
//   existing x-access-password: d1 model, so no schema is duplicated here.

const BASE = 'https://d1brain.netlify.app/.netlify/functions';
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'd1';
const MCP_TOKEN = process.env.MCP_TOKEN || 'd1mcp_jHDkb2bRW6pau-M_l11Jg-mWBtYMwglS';
const PROTOCOL_VERSION = '2025-06-18';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version',
};
const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json' };

// ---------- brain data helpers ----------
async function getBrain() {
  const r = await fetch(`${BASE}/brain`, { headers: { 'x-access-password': ACCESS_PASSWORD } });
  if (!r.ok) throw new Error(`brain GET failed: HTTP ${r.status}`);
  const j = await r.json();
  return j && j.data && j.data.tasks ? j.data : j; // tolerate either raw or {data} shape
}
async function saveBrain(brain, message) {
  const r = await fetch(`${BASE}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: brain, message: message || 'Update via D1Brain MCP', password: ACCESS_PASSWORD }),
  });
  if (!r.ok) throw new Error(`brain save failed: HTTP ${r.status} ${await r.text().catch(() => '')}`);
  return true;
}
function todaySAST() {
  return new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10); // Africa/Johannesburg = UTC+2
}
function fmtTask(t, i) {
  const bits = [];
  if (t.due) bits.push(`due ${t.due}`);
  if (t.flag) bits.push('⚑');
  const tags = (t.tags || []).length ? ` [${t.tags.join(', ')}]` : '';
  const meta = bits.length ? ` (${bits.join(', ')})` : '';
  return `${i + 1}. ${t.title}${meta}${tags}`;
}

// ---------- tool definitions ----------
const TOOLS = [
  {
    name: 'get_summary',
    description: "Get a high-level snapshot of Darren's D1Brain right now: this month's goal, this week's three focus items, today's stated priorities, and task counts (active / waiting on / someday) plus how many active tasks are overdue or due today. Use this to answer 'what's on my brain', 'what should I focus on', or 'give me the overview'.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_tasks',
    description: "List tasks from the brain. Use for 'what's on my list', 'what's due today', 'show me my d-one tasks', 'what am I waiting on'. Returns titles with due dates and tags.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'waitingOn', 'someday', 'done'], description: "Which list. Default 'active'." },
        tag: { type: 'string', description: 'Filter to one tag, e.g. d-one, family, finance, home, self, social, marriage, personal.' },
        due: { type: 'string', enum: ['today', 'overdue', 'week'], description: "Date filter: 'today', 'overdue' (past due, not done), or 'week' (due within 7 days)." },
        flagged: { type: 'boolean', description: 'Only flagged tasks.' },
        query: { type: 'string', description: 'Only tasks whose title contains this text (case-insensitive).' },
        limit: { type: 'number', description: 'Max tasks to return. Default 25.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_task',
    description: "Add a new task to the brain. Use whenever Darren says 'remind me to…', 'add a task…', 'note that…', 'don't let me forget…'. Writes to data/brain.json immediately.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The task, short and actionable.' },
        context: { type: 'string', description: 'Optional extra detail or note.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags: d-one, family, finance, home, self, social, marriage, personal, adventure, ideas, shopping. Default none.' },
        due: { type: 'string', description: "Optional due date as YYYY-MM-DD. Accepts 'today' or 'tomorrow' too." },
        flag: { type: 'boolean', description: 'Mark as important/flagged.' },
        status: { type: 'string', enum: ['active', 'someday', 'waitingOn'], description: "Which list to add to. Default 'active'." },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'complete_task',
    description: "Mark a task done and move it to the done list. Use for 'mark X done', 'I finished X', 'tick off X'. Matches by a piece of the task title (case-insensitive). If more than one matches, it lists them so you can be more specific.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text from the title of the task to complete.' },
        status: { type: 'string', enum: ['active', 'waitingOn', 'someday'], description: "Which list to search. Default 'active'." },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_parking_lot',
    description: "Capture an idea or something to look at later into the Parking Lot (not an active task). Use for 'park this', 'idea:', 'something to look into…'.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the idea.' },
        text: { type: 'string', description: 'Optional longer note.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
];

// ---------- tool execution ----------
function resolveDue(due) {
  if (!due) return '';
  const d = String(due).trim().toLowerCase();
  if (d === 'today') return todaySAST();
  if (d === 'tomorrow') return new Date(Date.now() + 2 * 3600 * 1000 + 86400000).toISOString().slice(0, 10);
  return due;
}

async function runTool(name, args) {
  args = args || {};
  if (name === 'get_summary') {
    const b = await getBrain();
    const today = todaySAST();
    const active = b.tasks?.active || [];
    const overdue = active.filter((t) => !t.done && t.due && t.due < today).length;
    const dueToday = active.filter((t) => !t.done && t.due === today).length;
    const wf = b.weeklyFocus || {};
    const three = (wf.three || []).map((x, i) => `  ${x.done ? '✓' : '○'} ${x.title}`).join('\n');
    const pri = b.dailyCheckin?.priorities || {};
    const out = [
      `📅 D1Brain — updated ${b.meta?.updated || '?'} (today is ${today})`,
      ``,
      `MONTHLY GOAL: ${b.monthlyGoal?.title || '—'}`,
      b.monthlyGoal?.statement ? `  ${b.monthlyGoal.statement}` : '',
      ``,
      `THIS WEEK'S THREE (week of ${wf.weekOf || '?'}):`,
      three || '  (none set)',
      ``,
      `TODAY'S PRIORITIES: day="${pri.day || '—'}" · week="${pri.week || '—'}" · month="${pri.month || '—'}"`,
      ``,
      `TASKS: ${active.length} active · ${b.tasks?.waitingOn?.length || 0} waiting on · ${b.tasks?.someday?.length || 0} someday`,
      `  → ${overdue} overdue, ${dueToday} due today`,
      `PARKING LOT: ${(b.parkingLot || []).length} items`,
    ].filter((l) => l !== '').join('\n');
    return out;
  }

  if (name === 'list_tasks') {
    const b = await getBrain();
    const status = args.status || 'active';
    let list = (b.tasks?.[status] || []).filter((t) => !t.done || status === 'done');
    const today = todaySAST();
    if (args.tag) list = list.filter((t) => (t.tags || []).map((x) => x.toLowerCase()).includes(String(args.tag).toLowerCase()));
    if (args.flagged) list = list.filter((t) => t.flag);
    if (args.query) list = list.filter((t) => (t.title || '').toLowerCase().includes(String(args.query).toLowerCase()));
    if (args.due === 'today') list = list.filter((t) => t.due === today);
    else if (args.due === 'overdue') list = list.filter((t) => t.due && t.due < today);
    else if (args.due === 'week') {
      const wk = new Date(Date.now() + 2 * 3600 * 1000 + 7 * 86400000).toISOString().slice(0, 10);
      list = list.filter((t) => t.due && t.due <= wk);
    }
    list.sort((a, b2) => (a.due || '9999').localeCompare(b2.due || '9999'));
    const total = list.length;
    const limit = Math.max(1, Math.min(args.limit || 25, 100));
    const shown = list.slice(0, limit);
    if (!total) return `No ${status} tasks match.`;
    const header = `${total} ${status} task${total === 1 ? '' : 's'}${args.tag ? ` tagged ${args.tag}` : ''}${args.due ? ` (${args.due})` : ''}${total > limit ? ` — showing first ${limit}` : ''}:`;
    return header + '\n' + shown.map(fmtTask).join('\n');
  }

  if (name === 'add_task') {
    if (!args.title || !String(args.title).trim()) return { error: 'title is required' };
    const b = await getBrain();
    const status = args.status || 'active';
    if (!b.tasks) b.tasks = {};
    if (!Array.isArray(b.tasks[status])) b.tasks[status] = [];
    const task = {
      title: String(args.title).trim(),
      context: args.context ? String(args.context) : '',
      tags: Array.isArray(args.tags) ? args.tags : [],
      flag: !!args.flag,
      due: resolveDue(args.due),
      odoo: null,
      done: false,
    };
    b.tasks[status].unshift(task);
    await saveBrain(b, `MCP add_task: ${task.title}`);
    return `Added to ${status}: "${task.title}"${task.due ? ` (due ${task.due})` : ''}${task.tags.length ? ` [${task.tags.join(', ')}]` : ''}.`;
  }

  if (name === 'complete_task') {
    if (!args.query || !String(args.query).trim()) return { error: 'query is required' };
    const b = await getBrain();
    const status = args.status || 'active';
    const list = b.tasks?.[status] || [];
    const q = String(args.query).toLowerCase();
    const matches = list.map((t, i) => ({ t, i })).filter((x) => (x.t.title || '').toLowerCase().includes(q) && !x.t.done);
    if (!matches.length) return `No open "${status}" task matches "${args.query}".`;
    if (matches.length > 1) {
      return `${matches.length} tasks match "${args.query}" — be more specific:\n` + matches.map((x, i) => `${i + 1}. ${x.t.title}`).join('\n');
    }
    const { t, i } = matches[0];
    t.done = true;
    list.splice(i, 1);
    if (!Array.isArray(b.tasks.done)) b.tasks.done = [];
    b.tasks.done.unshift(t);
    await saveBrain(b, `MCP complete_task: ${t.title}`);
    return `Done ✓ "${t.title}" — moved to the done list.`;
  }

  if (name === 'add_parking_lot') {
    if (!args.title || !String(args.title).trim()) return { error: 'title is required' };
    const b = await getBrain();
    if (!Array.isArray(b.parkingLot)) b.parkingLot = [];
    const item = {
      title: String(args.title).trim(),
      text: args.text ? String(args.text) : '',
      tags: Array.isArray(args.tags) ? args.tags : [],
      date: todaySAST(),
      done: false,
    };
    b.parkingLot.unshift(item);
    await saveBrain(b, `MCP add_parking_lot: ${item.title}`);
    return `Parked: "${item.title}".`;
  }

  return { error: `Unknown tool: ${name}` };
}

// ---------- JSON-RPC / MCP plumbing ----------
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'D1Brain', version: '1.0.0' },
      instructions: "Darren's Central Brain. Use get_summary for an overview, list_tasks to read the list, add_task to capture anything he wants remembered, complete_task to tick things off, add_parking_lot for ideas.",
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'resources/list') return rpcResult(id, { resources: [] });
  if (method === 'prompts/list') return rpcResult(id, { prompts: [] });
  if (method && method.startsWith('notifications/')) return null; // notifications get no response

  if (method === 'tools/call') {
    const toolName = params && params.name;
    const toolArgs = (params && params.arguments) || {};
    try {
      const res = await runTool(toolName, toolArgs);
      if (res && typeof res === 'object' && res.error) {
        return rpcResult(id, { content: [{ type: 'text', text: `Error: ${res.error}` }], isError: true });
      }
      return rpcResult(id, { content: [{ type: 'text', text: String(res) }] });
    } catch (e) {
      return rpcResult(id, { content: [{ type: 'text', text: `Error running ${toolName}: ${e.message}` }], isError: true });
    }
  }

  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // Auth
  const qs = event.queryStringParameters || {};
  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '');
  const provided = qs.k || qs.token || bearer;

  if (event.httpMethod === 'GET') {
    // Simple browser-visible health check (still requires token to avoid exposing existence casually)
    if (provided !== MCP_TOKEN) return { statusCode: 401, headers: { ...CORS, 'Content-Type': 'text/plain' }, body: 'Unauthorized' };
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'text/plain' }, body: 'D1Brain MCP server is live. POST JSON-RPC (MCP Streamable HTTP) to this URL.' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  if (provided !== MCP_TOKEN) return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify(rpcError(null, -32001, 'Unauthorized')) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(rpcError(null, -32700, 'Parse error')) }; }

  // Support single or batch
  if (Array.isArray(payload)) {
    const out = [];
    for (const m of payload) { const r = await handleRpc(m); if (r) out.push(r); }
    if (!out.length) return { statusCode: 202, headers: CORS, body: '' };
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(out) };
  }
  const resp = await handleRpc(payload);
  if (!resp) return { statusCode: 202, headers: CORS, body: '' }; // notification, no content
  return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(resp) };
};
