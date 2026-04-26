// notion-ai-bot/bot.js
// AI-powered Notion task assistant via Telegram
// Pre-configured for: Action Items Tracker database

import { scheduleJob } from "node-schedule";

const NOTION_TOKEN        = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID  = "2b877afd-3555-8042-800b-c4e0950c445d"; // Action Items Tracker data source
const TELEGRAM_TOKEN      = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;

// ─── Notion API ───────────────────────────────────────────────────────────────

async function notionRequest(endpoint, method = "GET", body = null) {
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${method} ${endpoint} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchTasksThisWeek() {
  const today = todayISO();
  const endOfWeek = endOfWeekISO();
  const data = await notionRequest(`/databases/${NOTION_DATABASE_ID}/query`, "POST", {
    filter: {
      and: [
        {
          or: [
            { property: "Urgency", select: { equals: "Today" } },
            { property: "Urgency", select: { equals: "This week" } },
            { property: "Deadline (date)", date: { on_or_after: today } },
          ]
        },
        { property: "Deadline (date)", date: { on_or_before: endOfWeek } },
        { property: "Status", select: { does_not_equal: "Done" } },
        { property: "Status", select: { does_not_equal: "Cancelled" } },
        { property: "Status", select: { does_not_equal: "Paused" } },
      ]
    },
    sorts: [
      { property: "Urgency", direction: "ascending" },
      { property: "Priority Score", direction: "descending" },
    ],
  });
  return data.results.map(parseTask);
}

async function fetchAllActiveTasks() {
  const data = await notionRequest(`/databases/${NOTION_DATABASE_ID}/query`, "POST", {
    filter: {
      and: [
        { property: "Status", select: { does_not_equal: "Done" } },
        { property: "Status", select: { does_not_equal: "Cancelled" } },
        { property: "Status", select: { does_not_equal: "Paused" } },
      ]
    },
    sorts: [
      { property: "Urgency", direction: "ascending" },
      { property: "Priority Score", direction: "descending" },
    ],
  });
  return data.results.map(parseTask);
}

async function updateTaskDeadline(taskId, newDate) {
  await notionRequest(`/pages/${taskId}`, "PATCH", {
    properties: { "Deadline (date)": { date: { start: newDate } } },
  });
}

async function updateTaskUrgency(taskId, urgency) {
  await notionRequest(`/pages/${taskId}`, "PATCH", {
    properties: {
      "Urgency": { select: { name: urgency } },
      "Urgency set on": { date: { start: todayISO() } },
    },
  });
}

async function updateTaskStatus(taskId, status) {
  await notionRequest(`/pages/${taskId}`, "PATCH", {
    properties: { "Status": { select: { name: status } } },
  });
}

async function createChecklist(pageId, items) {
  // items: string[]
  const children = items.map(text => ({
    object: "block",
    type: "to_do",
    to_do: {
      rich_text: [{ type: "text", text: { content: text } }],
      checked: false,
    },
  }));
  await notionRequest(`/blocks/${pageId}/children`, "PATCH", { children });
}

function parseTask(page) {
  const props = page.properties;
  return {
    id: page.id,
    name: props["Task"]?.title?.map(t => t.plain_text).join("") || "Untitled",
    deadline: props["Deadline (date)"]?.date?.start || null,
    status: props["Status"]?.select?.name || null,
    urgency: props["Urgency"]?.select?.name || null,
    importance: props["Importance"]?.number || null,
    fulfillment: props["Fulfillment"]?.number || null,
    priorityScore: props["Priority Score"]?.formula?.number || null,
    tags: props["Tags"]?.multi_select?.map(t => t.name) || [],
    notes: props["Notes"]?.rich_text?.map(t => t.plain_text).join("") || null,
  };
}

// ─── Fetch page checklist items ──────────────────────────────────────────────

async function fetchPageChecklist(pageId) {
  try {
    const data = await notionRequest(`/blocks/${pageId}/children`);
    const items = [];
    for (const block of data.results || []) {
      if (block.type === "to_do") {
        const text = block.to_do?.rich_text?.map(t => t.plain_text).join("") || "";
        const checked = block.to_do?.checked || false;
        if (text) items.push({ text, checked });
      }
    }
    return items;
  } catch {
    return []; // silently skip if page can't be fetched
  }
}

async function enrichTasksWithChecklists(tasks) {
  return Promise.all(tasks.map(async t => {
    const checklist = await fetchPageChecklist(t.id);
    return { ...t, checklist };
  }));
}

// ─── Claude AI ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a personal task assistant connected to the user's Notion "Action Items Tracker" database.

Database schema:
- Task: title
- Status: "Not started" | "In progress" | "Done" | "Paused" | "Cancelled"
- Urgency: "Today" | "This week" | "This month" | "This half" | "Not urgent"
- Deadline (date): YYYY-MM-DD
- Importance: number (higher = more important)
- Priority Score: formula, read-only
- Tags: Work | Family | Travel | Personal | Child Care
- Notes: text (context/background info)
- Checklist: to-do items inside the task page, shown as [x] done or [ ] pending

When the user asks about progress on a task or what to do next, reference the checklist items.
You can perform these actions:
- reschedule: update Deadline (date)
- set_urgency: update Urgency field
- set_status: update Status field
- mark_done: set Status to Done

Respond ONLY in this exact JSON format:
{
  "message": "friendly plain-text reply for the user",
  "action": null | {
    "type": "reschedule" | "set_urgency" | "set_status" | "mark_done" | "create_checklist",
    "taskId": "page-uuid",
    "newDate": "YYYY-MM-DD",
    "urgency": "Today" | "This week" | "This month" | "This half" | "Not urgent",
    "status": "Not started" | "In progress" | "Done" | "Paused" | "Cancelled",
    "checklist": ["step 1", "step 2", "step 3"]
  }
}

Rules:
- message is plain text only, no markdown
- If multiple tasks match ambiguously, ask for clarification and set action to null
- Be concise and friendly
- Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
- When rescheduling to named days like "Friday", calculate the correct ISO date
- For create_checklist: generate 3-6 realistic, small, actionable steps based on the task name and context. Each step should be completable in 30 mins or less. Also auto set status to "In progress".`;

async function askClaude(userMessage, tasks) {
  const tasksCtx = tasks.length > 0
    ? tasks.map(t => {
        const checklistStr = t.checklist?.length
          ? "\n    Checklist: " + t.checklist.map(c => `[${c.checked ? "x" : " "}] ${c.text}`).join(", ")
          : "";
        return `- [${t.id}] "${t.name}" | urgency: ${t.urgency || "none"} | deadline: ${t.deadline || "none"} | status: ${t.status} | priority: ${t.priorityScore ?? "?"} | tags: ${t.tags.join(", ") || "none"}${checklistStr}`;
      }).join("\n")
    : "No active tasks.";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Tasks:\n${tasksCtx}\n\nUser: "${userMessage}"` }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  const raw = data.content[0].text.trim().replace(/```json\n?|```/g, "").trim();
  try { return JSON.parse(raw); }
  catch { return { message: raw, action: null }; }
}

// ─── Telegram API ─────────────────────────────────────────────────────────────

async function telegramRequest(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Telegram ${method} → ${res.status}`);
  return res.json();
}

const sendMessage = (chatId, text) => telegramRequest("sendMessage", { chat_id: chatId, text });
const getUpdates = (offset) => telegramRequest("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });

// ─── Morning Digest ───────────────────────────────────────────────────────────

async function fetchOverdueTasks() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayISO = yesterday.toISOString().split("T")[0];
  const data = await notionRequest(`/databases/${NOTION_DATABASE_ID}/query`, "POST", {
    filter: {
      and: [
        { property: "Deadline (date)", date: { before: todayISO() } },
        { property: "Status", select: { does_not_equal: "Done" } },
        { property: "Status", select: { does_not_equal: "Cancelled" } },
        { property: "Status", select: { does_not_equal: "Paused" } },
      ]
    },
    sorts: [{ property: "Deadline (date)", direction: "ascending" }],
  });
  return data.results.map(parseTask);
}

function formatDigest(tasks, overdueTasks) {
  const today = todayISO();

  // Status icon inline
  const statusLabel = t => t.status === "In progress" ? "In progress" : "Not started";

  // Task line: priority-ranked, status inline, deadline
  const taskLine = t => {
    const dl = t.deadline ? ` · ${formatDate(t.deadline)}` : "";
    const status = statusLabel(t);
    const checklist = t.checklist || [];
    const done = checklist.filter(c => c.checked).length;
    const total = checklist.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const progress = total > 0 ? ` · ${done}/${total} done (${pct}%)` : "";
    return `  • ${t.name} [${status}]${progress}${dl}`;
  };

  const overdueLine = t => {
    const daysAgo = Math.floor((new Date(today) - new Date(t.deadline)) / 86400000);
    const status = statusLabel(t);
    const checklist = t.checklist || [];
    const done = checklist.filter(c => c.checked).length;
    const total = checklist.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const progress = total > 0 ? ` · ${done}/${total} done (${pct}%)` : "";
    return `  • ${t.name} [${status}]${progress} · ${daysAgo}d ago`;
  };

  // Neutral, calm greetings — no hype
  const greetings = [
    "Morning. Here's where things stand today.",
    "Good morning. Here's your day at a glance.",
    "Morning. Here's what's on your plate.",
    "Good morning. Here's your focus for today.",
    "Morning. Here's what's ahead.",
    "Good morning. Here's your plan.",
    "Morning. Here's a look at your week.",
  ];
  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const greeting = greetings[new Date().getDay()];

  let msg = `${greeting}
${dateStr}
`;

  // Overdue — self-compassion + autonomy framing, no guilt
  if (overdueTasks.length > 0) {
    // Sort overdue by priority score desc
    const sorted = [...overdueTasks].sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));
    msg += `
Carried forward — still worth doing:
`;
    sorted.forEach(t => { msg += overdueLine(t) + "
"; });
  }

  // This week + today tasks sorted by priority score desc
  if (tasks.length > 0) {
    const sorted = [...tasks].sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));
    const todayTasks = sorted.filter(t => t.urgency === "Today");
    const restTasks  = sorted.filter(t => t.urgency !== "Today");

    if (todayTasks.length) {
      msg += `
Focus for today:
`;
      todayTasks.forEach(t => { msg += taskLine(t) + "
"; });
    }

    if (restTasks.length) {
      msg += `
This week:
`;
      restTasks.forEach(t => { msg += taskLine(t) + "
"; });
    }
  }

  // Progress summary — progress principle
  const allTasks = [...overdueTasks, ...tasks];
  const inProgress = allTasks.filter(t => t.status === "In progress").length;
  const total = allTasks.length;

  if (inProgress > 0) {
    msg += `
${inProgress} already in motion out of ${total} total — keep going.`;
  } else {
    msg += `
${total} task${total !== 1 ? "s" : ""} on your radar this week.`;
  }

  msg += `
Reply to update any task, or just ask what to focus on first.`;
  return msg;
}


async function sendMorningDigest() {
  console.log(`[${new Date().toISOString()}] Sending digest...`);
  try {
    const [tasks, overdueTasks] = await Promise.all([
      fetchTasksThisWeek(),
      fetchOverdueTasks(),
    ]);
    await sendMessage(TELEGRAM_CHAT_ID, formatDigest(tasks, overdueTasks));
    console.log("✅ Digest sent");
  } catch (err) { console.error("❌ Digest error:", err.message); }
}

// ─── Handle Incoming Messages ─────────────────────────────────────────────────

async function handleMessage(text) {
  console.log(`Handling: "${text}"`);
  const rawTasks = await fetchAllActiveTasks();
  const tasks = await enrichTasksWithChecklists(rawTasks);
  const { message, action } = await askClaude(text, tasks);

  if (action?.taskId) {
    if (action.type === "reschedule" && action.newDate) await updateTaskDeadline(action.taskId, action.newDate);
    else if (action.type === "set_urgency" && action.urgency) await updateTaskUrgency(action.taskId, action.urgency);
    else if (action.type === "set_status" && action.status) await updateTaskStatus(action.taskId, action.status);
    else if (action.type === "mark_done") await updateTaskStatus(action.taskId, "Done");
    else if (action.type === "create_checklist" && action.checklist?.length) {
      await createChecklist(action.taskId, action.checklist);
      await updateTaskStatus(action.taskId, "In progress");
    }
  }

  await sendMessage(TELEGRAM_CHAT_ID, message);
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

async function startPolling() {
  let offset = 0;
  console.log("👂 Listening for messages...");
  while (true) {
    try {
      const result = await getUpdates(offset);
      for (const update of result.result || []) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text || String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) continue;
        await handleMessage(msg.text);
      }
    } catch (err) {
      console.error("Polling error:", err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayISO() { return new Date().toISOString().split("T")[0]; }
function endOfWeekISO() {
  const d = new Date(); d.setDate(d.getDate() + (7 - d.getDay()));
  return d.toISOString().split("T")[0];
}
function formatDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🤖 Action Items Bot starting...");
  scheduleJob(process.env.CRON_SCHEDULE || "0 1 * * *", sendMorningDigest);
  await startPolling();
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
