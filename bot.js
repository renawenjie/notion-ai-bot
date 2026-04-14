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
            {
              and: [
                { property: "Deadline (date)", date: { on_or_after: today } },
                { property: "Deadline (date)", date: { on_or_before: endOfWeek } },
              ]
            }
          ]
        },
        { property: "Status", select: { does_not_equal: "Done" } },
        { property: "Status", select: { does_not_equal: "Cancelled" } },
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
- Notes: text

You can perform these actions:
- reschedule: update Deadline (date)
- set_urgency: update Urgency field
- set_status: update Status field
- mark_done: set Status to Done

Respond ONLY in this exact JSON format:
{
  "message": "friendly plain-text reply for the user",
  "action": null | {
    "type": "reschedule" | "set_urgency" | "set_status" | "mark_done",
    "taskId": "page-uuid",
    "newDate": "YYYY-MM-DD",
    "urgency": "Today" | "This week" | "This month" | "This half" | "Not urgent",
    "status": "Not started" | "In progress" | "Done" | "Paused" | "Cancelled"
  }
}

Rules:
- message is plain text only, no markdown
- If multiple tasks match ambiguously, ask for clarification and set action to null
- Be concise and friendly
- Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
- When rescheduling to named days like "Friday", calculate the correct ISO date`;

async function askClaude(userMessage, tasks) {
  const tasksCtx = tasks.length > 0
    ? tasks.map(t => `- [${t.id}] "${t.name}" | urgency: ${t.urgency || "none"} | deadline: ${t.deadline || "none"} | status: ${t.status} | priority: ${t.priorityScore ?? "?"} | tags: ${t.tags.join(", ") || "none"}`).join("\n")
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
  try { return JSON.parse(data.content[0].text.trim()); }
  catch { return { message: data.content[0].text.trim(), action: null }; }
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

function formatDigest(tasks) {
  const todayTasks = tasks.filter(t => t.urgency === "Today");
  const weekTasks  = tasks.filter(t => t.urgency === "This week");
  const otherTasks = tasks.filter(t => !["Today", "This week"].includes(t.urgency) && t.deadline);

  const line = t => {
    const tag = t.tags.length ? ` [${t.tags.join(", ")}]` : "";
    const dl = t.deadline ? ` — ${formatDate(t.deadline)}` : "";
    return `  • ${t.name}${tag}${dl}`;
  };

  let msg = `Good morning! ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}\n\n`;
  msg += "TODAY\n" + (todayTasks.length ? todayTasks.map(line).join("\n") : "  Nothing marked as Today.");
  if (weekTasks.length) msg += "\n\nTHIS WEEK\n" + weekTasks.map(line).join("\n");
  if (otherTasks.length) msg += "\n\nCOMING UP\n" + otherTasks.map(line).join("\n");
  msg += `\n\n${tasks.length} active task${tasks.length !== 1 ? "s" : ""} total. Reply to update, reschedule, or ask anything.`;
  return msg;
}

async function sendMorningDigest() {
  console.log(`[${new Date().toISOString()}] Sending digest...`);
  try {
    const tasks = await fetchTasksThisWeek();
    await sendMessage(TELEGRAM_CHAT_ID, formatDigest(tasks));
    console.log("✅ Digest sent");
  } catch (err) { console.error("❌ Digest error:", err.message); }
}

// ─── Handle Incoming Messages ─────────────────────────────────────────────────

async function handleMessage(text) {
  console.log(`Handling: "${text}"`);
  const tasks = await fetchAllActiveTasks();
  const { message, action } = await askClaude(text, tasks);

  if (action?.taskId) {
    if (action.type === "reschedule" && action.newDate) await updateTaskDeadline(action.taskId, action.newDate);
    else if (action.type === "set_urgency" && action.urgency) await updateTaskUrgency(action.taskId, action.urgency);
    else if (action.type === "set_status" && action.status) await updateTaskStatus(action.taskId, action.status);
    else if (action.type === "mark_done") await updateTaskStatus(action.taskId, "Done");
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
