// D1Brain MCP server — stateless Streamable-HTTP MCP endpoint for the Claude app / voice mode.
// Backs Darren's Central Brain with NOTION (the "Priorities" + "Parking Lot" databases).
// As of the 2026-09 cutover this server reads/writes Notion ONLY — nothing touches brain.json.
//
// Auth: a token must be supplied on every request, either as a query param (?k=TOKEN) or an
//   Authorization: Bearer TOKEN header. Set MCP_TOKEN in Netlify env to override the fallback.
// Data path: this function calls the Notion API directly (server-to-server) with an integration
//   token. Override any constant via a matching Netlify env var.

const NOTION_TOKEN = process.env.NOTION_TOKEN || 'ntn_MZh412605917806kUiwE6xk0bGfKoBthE6MYI8ZzKkC9LP';
const NOTION_VERSION = '2022-06-28';
const TASKS_DB = process.env.NOTION_TASKS_DB || '3e100275-962f-8177-bc9f-e6cf78919ad0';
const PARKING_DB = process.env.NOTION_PARKING_DB || '3e100275-962f-816f-8522-e265091b917c';
const MCP_TOKEN = process.env.MCP_TOKEN || 'd1mcp_jHDkb2bRW6pau-M_l11Jg-mWBtYMwglS';
const PROTOCOL_VERSION = '2025-06-18';

// Map the MCP status vocabulary to the Notion "Status" select options.
const STATUS_MAP = { active: 'Active', waitingOn: 'Waiting On', someday: 'Someday', done: 'Done' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version',
};
const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json' };

// ---------- Notion helpers ----------
async function notion(path, method = 'GET', body) {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Notion ${method} ${path} failed: HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
async function queryAll(dbId, filter, sorts, cap = 500) {
  let results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;
    const j = await notion(`/databases/${dbId}/query`, 'POST', body);
    results = results.concat(j.results || []);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor && results.length < cap);
  return results;
}
function todaySAST() {
  return new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10); // Africa/Johannesburg = UTC+2
}
// ---- Notion page -> plain field readers ----
function pTitle(p) {
  const a = p.properties?.Name?.title || [];
  return a.map((x) => x.plain_text || (x.text && x.text.content) || '').join('').trim();
}
function pDue(p) { return p.properties?.Due?.date?.start || ''; }
function pFlag(p) { return !!p.properties?.['⭐ Priority']?.checkbox; }
function pDone(p) { return !!p.properties?.['✓ Done']?.checkbox; }
function pTags(p) { return (p.properties?.Tags?.multi_select || []).map((o) => o.name); }
function fmtTask(p, i) {
  const bits = [];
  const due = pDue(p);
  if (due) bits.push(`due ${due}`);
  if (pFlag(p)) bits.push('⚑');
  const tags = pTags(p);
  const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
  const meta = bits.length ? ` (${bits.join(', ')})` : '';
  return `${i + 1}. ${pTitle(p)}${meta}${tagStr}`;
}

// ---------- tool definitions ----------
const TOOLS = [
  {
    name: 'get_summary',
    description: "Get a high-level snapshot of Darren's D1Brain right now: task counts (active / waiting on / someday), how many active tasks are overdue or due today, and the parking-lot count. Use this to answer 'what's on my brain', 'what should I focus on', or 'give me the overview'.",
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
    description: "Add a new task to the brain. Use whenever Darren says 'remind me to…', 'add a task…', 'note that…', 'don't let me forget…'. Saves it to Notion immediately.",
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
    description: "Mark a task done. Use for 'mark X done', 'I finished X', 'tick off X'. Matches by a piece of the task title (case-insensitive). If more than one matches, it lists them so you can be more specific.",
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
    const today = todaySAST();
    const active = await queryAll(TASKS_DB, { and: [{ property: 'Status', select: { equals: 'Active' } }, { property: '✓ Done', checkbox: { equals: false } }] }, [{ property: 'Due', direction: 'ascending' }]);
    const overdue = active.filter((p) => { const d = pDue(p); return d && d < today; }).length;
    const dueToday = active.filter((p) => pDue(p) === today).length;
    const waiting = await queryAll(TASKS_DB, { and: [{ property: 'Status', select: { equals: 'Waiting On' } }, { property: '✓ Done', checkbox: { equals: false } }] });
    const someday = await queryAll(TASKS_DB, { and: [{ property: 'Status', select: { equals: 'Someday' } }, { property: '✓ Done', checkbox: { equals: false } }] });
    const parking = await queryAll(PARKING_DB, { property: 'Done', checkbox: { equals: false } });
    const dueTodayTitles = active.filter((p) => pDue(p) === today).slice(0, 5).map((p) => `  • ${pTitle(p)}`).join('\n');
    const out = [
      `📅 D1Brain (Notion) — today is ${today}`,
      ``,
      `TASKS: ${active.length} active · ${waiting.length} waiting on · ${someday.length} someday`,
      `  → ${overdue} overdue, ${dueToday} due today`,
      dueToday ? `DUE TODAY:\n${dueTodayTitles}` : '',
      `PARKING LOT: ${parking.length} open items`,
    ].filter((l) => l !== '').join('\n');
    return out;
  }

  if (name === 'list_tasks') {
    const status = args.status || 'active';
    const sName = STATUS_MAP[status] || 'Active';
    const today = todaySAST();
    const and = [{ property: 'Status', select: { equals: sName } }];
    if (status !== 'done') and.push({ property: '✓ Done', checkbox: { equals: false } });
    if (args.tag) and.push({ property: 'Tags', multi_select: { contains: String(args.tag) } });
    if (args.flagged) and.push({ property: '⭐ Priority', checkbox: { equals: true } });
    if (args.query) and.push({ property: 'Name', title: { contains: String(args.query) } });
    if (args.due === 'today') and.push({ property: 'Due', date: { equals: today } });
    else if (args.due === 'overdue') and.push({ property: 'Due', date: { before: today } });
    else if (args.due === 'week') {
      const wk = new Date(Date.now() + 2 * 3600 * 1000 + 7 * 86400000).toISOString().slice(0, 10);
      and.push({ property: 'Due', date: { on_or_before: wk } });
    }
    const list = await queryAll(TASKS_DB, { and }, [{ property: 'Due', direction: 'ascending' }]);
    const total = list.length;
    if (!total) return `No ${status} tasks match.`;
    const limit = Math.max(1, Math.min(args.limit || 25, 100));
    const shown = list.slice(0, limit);
    const header = `${total} ${status} task${total === 1 ? '' : 's'}${args.tag ? ` tagged ${args.tag}` : ''}${args.due ? ` (${args.due})` : ''}${total > limit ? ` — showing first ${limit}` : ''}:`;
    return header + '\n' + shown.map(fmtTask).join('\n');
  }

  if (name === 'add_task') {
    if (!args.title || !String(args.title).trim()) return { error: 'title is required' };
    const status = args.status || 'active';
    const title = String(args.title).trim();
    const due = resolveDue(args.due);
    const tags = Array.isArray(args.tags) ? args.tags.filter(Boolean) : [];
    const props = {
      Name: { title: [{ text: { content: title } }] },
      Status: { select: { name: STATUS_MAP[status] || 'Active' } },
      Source: { select: { name: 'Voice' } },
      '⭐ Priority': { checkbox: !!args.flag },
      '✓ Done': { checkbox: false },
    };
    if (tags.length) props.Tags = { multi_select: tags.map((t) => ({ name: String(t) })) };
    if (due) props.Due = { date: { start: due } };
    if (args.context) props.Context = { rich_text: [{ text: { content: String(args.context).slice(0, 1900) } }] };
    await notion('/pages', 'POST', { parent: { database_id: TASKS_DB }, properties: props });
    return `Added to ${status}: "${title}"${due ? ` (due ${due})` : ''}${tags.length ? ` [${tags.join(', ')}]` : ''}.`;
  }

  if (name === 'complete_task') {
    if (!args.query || !String(args.query).trim()) return { error: 'query is required' };
    const status = args.status || 'active';
    const sName = STATUS_MAP[status] || 'Active';
    const q = String(args.query).trim();
    const matches = await queryAll(TASKS_DB, {
      and: [
        { property: 'Status', select: { equals: sName } },
        { property: '✓ Done', checkbox: { equals: false } },
        { property: 'Name', title: { contains: q } },
      ],
    });
    if (!matches.length) return `No open "${status}" task matches "${q}".`;
    if (matches.length > 1) {
      return `${matches.length} tasks match "${q}" — be more specific:\n` + matches.map((p, i) => `${i + 1}. ${pTitle(p)}`).join('\n');
    }
    const page = matches[0];
    await notion(`/pages/${page.id}`, 'PATCH', {
      properties: { Status: { select: { name: 'Done' } }, '✓ Done': { checkbox: true } },
    });
    return `Done ✓ "${pTitle(page)}" — marked complete.`;
  }

  if (name === 'add_parking_lot') {
    if (!args.title || !String(args.title).trim()) return { error: 'title is required' };
    const title = String(args.title).trim();
    const tags = Array.isArray(args.tags) ? args.tags.filter(Boolean) : [];
    const props = {
      Name: { title: [{ text: { content: title } }] },
      Date: { date: { start: todaySAST() } },
      Done: { checkbox: false },
    };
    if (args.text) props.Notes = { rich_text: [{ text: { content: String(args.text).slice(0, 1900) } }] };
    if (tags.length) props.Tags = { multi_select: tags.map((t) => ({ name: String(t) })) };
    await notion('/pages', 'POST', { parent: { database_id: PARKING_DB }, properties: props });
    return `Parked: "${title}".`;
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
      serverInfo: { name: 'D1Brain', version: '2.0.0' },
      instructions: "Darren's Central Brain (Notion-backed). Use get_summary for an overview, list_tasks to read the list, add_task to capture anything he wants remembered, complete_task to tick things off, add_parking_lot for ideas.",
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
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'text/plain' }, body: 'D1Brain MCP server is live (Notion-backed). POST JSON-RPC (MCP Streamable HTTP) to this URL.' };
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
