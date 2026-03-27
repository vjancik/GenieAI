# GenieAI — Feature Reference

A Discord AI assistant powered by Google Gemini. This document covers all user-facing features.

---

## Triggering the Bot

**@Mention** — mention the bot explicitly in any channel message:
> `@Genie what is the capital of France?`

**Text command prefixes** — start a message with:
- `!ai <question>` — general-purpose AI query
- `!aisearch <query>` — explicitly request a web search

**Direct Messages** — when DMs are enabled, the same trigger rules apply: you still need an `@mention` or a `!ai`/`!aisearch` prefix.

**Reply chains** — the bot tracks conversation context through Discord reply threads; mention the bot in a reply to continue a conversation.

> The bot ignores messages from other bots and messages without an explicit mention or recognized prefix.

---

## Attachments & Media

You can attach files directly to your message:

- **Images, PDFs, and other file types** are passed to the AI along with your text.
- Maximum attachment size per message (and per file): 100 MB in `inline` mode; 2GB in `upload` mode.
- Maximum attachment size per conversation (whole history): 100 MB in `inline` mode; unlimited in `upload` mode (Unchecked context window limit + 20GB per API key upload limit).

**Embedded content**: Embeds, forwarded messages, and embedded media from other channels are also extracted and made available to the AI.

---

## What the AI Can Do

The AI automatically decides whether to use any of the following tools to answer your question:

### Web Search

Searches the web for current events, recent news, or up-to-date information. When results are used, sources are listed at the bottom of the response:
> *Sources: [Title](url), ...*

### Website Fetching

Fetches and reads a specific URL if you link to a web page. The page is converted to readable text and passed to the AI.

### Video Caption Extraction

Extracts transcripts or captions from YouTube videos (and other supported platforms). Useful for questions about the content of a video you've linked.

---

## Response Formatting

Responses support standard Discord Markdown (bold, italic, code blocks, lists, etc.) as well as:

- **Math equations** — inline (`$E = mc^2$`) and block (`$$...$$`)
- **Tables** — GitHub Flavored Markdown pipe tables
- **Code blocks** — with syntax highlighting

---

## Long Responses & Pagination

Responses longer than Discord's 2000-character limit are automatically split into pages. A **Next Page** button appears at the bottom of each page. Code blocks that span page boundaries are continued cleanly on the next page. The button disappears on the final page.

---

## Render as Image

When a response contains equations or tables, a **Render** button appears. Clicking it converts the response to a PNG image — useful for displaying math or complex tables that look better visually.

---

## Retry

If a response fails or is degraded, a **Retry** button appears. Clicking it re-runs the request with the same conversation context.

- Failed responses can be retried by anyone.
- Fallback responses (partial success) can only be retried by the original requester.
- Up to 3 retries per response.

---

## Context Menu Commands

Right-click any bot message for these options:

### Summarize

Summarizes the bot's message (or any message) inline. The summary appears as a new response in the channel.

### Export as HTML

Downloads the bot's message as a rendered HTML file. Only works on messages from the bot.

### Export as Image

Downloads the bot's message as a PNG image (with full markdown and equation rendering). Only works on messages from the bot.

---

## Conversation History

The bot remembers the full conversation in a reply thread. It walks back through the Discord reply chain to reconstruct context, so previous messages in a thread are always included when generating a response. This persists across bot restarts.

---

## Status Updates

While processing, the bot shows a live status message:

- Analyzing your request
- Downloading attachments
- Fetching content
- Searching the web
- Generating response

The status message includes a relative timestamp (e.g., "thinking since 2 seconds ago").

---

## Rate Limiting

To prevent abuse, the bot enforces per-user rate limits:

- **Burst**: max 3 messages per 3 seconds
- **Sustained**: max 10 messages per 60 seconds

If you hit the limit, you'll see:
> *It seems you have sent too many messages at once recently. Please wait a while before sending more.*

---

## Direct Messages

When DMs are enabled, the same trigger rules apply as in guild channels — you still need an `@mention` or a `!ai`/`!aisearch` prefix. Full functionality (tools, pagination, history, context menus) is available in DMs.

---

## Empty Mention

If you @mention the bot with no message text and no attachments, it will introduce itself.

---

## Graceful Restart

If the bot is restarting, any new interaction will receive:
> *A restart is pending, try again later.*

In-flight responses are completed before the bot shuts down.

---

## Permission Requirements

- The bot must have **Send Messages** and **Read Message History** permissions in the target channel.
- Context menu commands (Summarize, Export) check permissions before proceeding and will reply with an error if the bot cannot send messages in that channel.
- Export commands only work on messages authored by the bot.
