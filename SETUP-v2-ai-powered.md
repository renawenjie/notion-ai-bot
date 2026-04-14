# Notion AI Task Bot — Setup Guide

## What it does

- **8 AM every day** → sends your daily + weekly task digest
- **Reply anytime** in plain English:
  - "Move the report to Friday"
  - "What's due this week?"
  - "Mark the client call as done"
  - "What should I focus on today?"
  - "Push everything from Wednesday to Thursday"

Claude reads your Notion tasks, understands your intent, and updates Notion directly.

---

## Prerequisites

- Node.js 18+
- A Notion database with tasks (needs Date + Status columns at minimum)
- A Telegram account
- An Anthropic API key → https://console.anthropic.com

---

## Step 1: Telegram Bot (2 min)

1. Message **@BotFather** on Telegram
2. Send `/newbot` → follow prompts → save the **Bot Token**
3. Message your new bot anything, then visit:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Find `"chat":{"id":XXXXXXXXX}` → that's your **Chat ID**

---

## Step 2: Notion Integration (3 min)

1. Go to https://www.notion.so/my-integrations → New Integration
2. Copy the **Internal Integration Token**
3. Open your database → `...` → Connections → add your integration
4. Copy the **Database ID** from the URL:
   `notion.so/workspace/THIS_PART_HERE?v=...`

---

## Step 3: Customize property names in bot.js

Open `bot.js` and update these 3 places to match your Notion columns:

```js
// In fetchTasksThisWeek() and fetchAllActiveTasks():
property: "Deadline"           // → your date column name
status: { does_not_equal: "Done" }  // → your "completed" status value

// In parseTask():
props["Deadline"]?.date?.start  // → your date column name
props["Status"]?.status?.name   // → your status column name
props["Priority"]?.select?.name // → your priority column name (or remove)

// In updateTaskDeadline():
Deadline: { date: { start: newDate } }  // → your date column name

// In markTaskDone():
Status: { status: { name: "Done" } }    // → your done status value
```

---

## Step 4: Install & run

```bash
cd notion-ai-bot
npm install

export NOTION_TOKEN="secret_xxxxxxxxxxxx"
export NOTION_DATABASE_ID="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TELEGRAM_TOKEN="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
export TELEGRAM_CHAT_ID="123456789"
export ANTHROPIC_API_KEY="sk-ant-xxxxxxxxxxxx"

npm start
```

---

## Step 5: Deploy so it runs 24/7

### Railway (recommended — free tier works)

1. Push to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Add all 5 environment variables in Railway's Variables tab
4. Done — Railway keeps it running and handles the built-in scheduler

### Render (alternative free option)

1. Create a new Web Service on https://render.com
2. Connect your GitHub repo
3. Set Build Command: `npm install`
4. Set Start Command: `npm start`
5. Add environment variables
6. Note: Render free tier spins down after inactivity — use Railway instead

---

## Example conversations

```
You:  Move the Q2 report to Thursday
Bot:  Done! "Q2 Report" has been rescheduled to Thursday, Apr 17.

You:  What's the most urgent thing today?
Bot:  You have 2 tasks due today. The highest priority is "Submit expense 
      report" (marked High). After that, "Review PRs from team".

You:  Mark the client call as done
Bot:  "Client call prep" marked as done! You have 4 tasks remaining this week.

You:  I won't have time for anything on Wednesday, push it all to Thursday
Bot:  I found 2 tasks on Wednesday: "Update docs" and "Team sync notes". 
      I've moved both to Thursday. Want me to check if Thursday is already busy?
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Bot doesn't respond | Check TELEGRAM_CHAT_ID matches your actual chat ID |
| "Notion 401" | Token is wrong or integration not connected to the DB |
| "Notion 400" | Property name mismatch — check spelling exactly |
| Claude gives wrong task | Task names might be ambiguous — Claude will ask to clarify |
| `node-schedule` error | Run `npm install` first |
