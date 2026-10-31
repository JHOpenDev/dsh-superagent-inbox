/**
 * The inbox Source: a file-based universal channel for dsh-superagent. Each conversation is a directory tree under a
 * configured root; a person drops message JSON files into `<conversation>/in/`, the Source turns each one into a Trigger,
 * and the agent's replies land in `<conversation>/out/` as reply JSON files. It needs no external account or bot, so a
 * deployment can drive the whole Trigger → Eval → Ticket → Worker → Channel flow with nothing but the filesystem.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

/** The `from` identity the Channel writes into every reply; a message with this sender never becomes a Trigger. */
export const INBOX_AGENT_FROM = 'dsh-superagent'
/** How many thread messages one `threadContext.read` page returns. */
const PAGE_SIZE = 50

const ConfigSchema = z.object({
  /** Absolute path of the inbox root; each configured conversation is `<root>/<id>/in` and `<root>/<id>/out`. */
  root: z.string().trim().min(1),
  /** The name a message's `to` field must carry to address the agent; `agent` by default. */
  agentName: z.string().trim().min(1).default('agent'),
  conversations: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(5).max(3600).default(10),
}).strict()
export type InboxConfig = z.infer<typeof ConfigSchema>

/** One message file as its JSON; unknown members are kept out of the way by the loose shape. */
const MessageSchema = z.looseObject({
  id: z.string().min(1),
  from: z.string().min(1),
  text: z.string(),
  at: z.string().optional(),
  bot: z.boolean().default(false),
  to: z.string().optional(),
  thread: z.string().optional(),
  reply_to: z.string().optional(),
  url: z.string().optional(),
})
export type InboxMessage = z.infer<typeof MessageSchema>

/** Valid timestamp in ISO form, or `fallback` when `value` does not parse. */
function time(value: string | undefined, fallback: string): string {
  if (value) { const at = new Date(value); if (!Number.isNaN(at.getTime())) return at.toISOString() }
  return fallback
}

/**
 * The Trigger of one inbox message; the agent's own replies produce none. The Trigger id and the Thread id derive from
 * the conversation and message ids, so re-reading a file is safe, and the reply address carries the inbox root (`dir`)
 * and the Thread root (`thread`), so the Channel needs no configuration lookup and every reply joins its Thread.
 */
export function inboxTrigger(message: InboxMessage, conversation: string, at: string, config: InboxConfig): Trigger | undefined {
  if (message.from === INBOX_AGENT_FROM || message.from === config.agentName) return undefined
  const root = message.thread ?? message.id
  const thread = `${conversation}:${root}`
  const addressed = message.to === 'agent' || message.to === config.agentName
  return {
    id: key('inbox', conversation, message.id),
    source: 'inbox',
    threads: [{ source: 'inbox', id: thread }],
    actor: { source: 'inbox', id: message.from },
    human: !message.bot,
    ...(addressed ? { addressed: 'mention' as const } : {}),
    at,
    text: message.text,
    channel: { source: 'inbox', thread: `inbox:${thread}`,
      address: { conversation, message: message.id, dir: config.root, thread: root } },
    ...(message.url ? { url: message.url } : {}),
    meta: { conversation, messageId: message.id, root, ...(message.reply_to ? { replyTo: message.reply_to } : {}) },
  }
}

const inboxDir = (root: string, conversation: string): string => join(root, conversation, 'in')
const outDir = (root: string, conversation: string): string => join(root, conversation, 'out')

/** Moves one processed message file into the conversation's `in/done/`, the inbox's read position. */
async function moveDone(dir: string, path: string, name: string): Promise<void> {
  const done = join(dir, 'done')
  await mkdir(done, { recursive: true })
  await rename(path, join(done, name))
}

/** Reads every message of one conversation still waiting in `in/`, with the count of files it could not read. */
async function readConversation(root: string, conversation: string): Promise<{ waiting: { name: string; path: string; message: InboxMessage }[]; unreadable: number }> {
  const dir = inboxDir(root, conversation)
  if (!existsSync(dir)) return { waiting: [], unreadable: 0 }
  const waiting: { name: string; path: string; message: InboxMessage }[] = []
  let unreadable = 0
  for (const name of (await readdir(dir)).filter(name => name.endsWith('.json')).sort()) {
    const path = join(dir, name)
    try { waiting.push({ name, path, message: MessageSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }) } catch { unreadable++ }
  }
  return { waiting, unreadable }
}

/**
 * One polling round: reads each configured conversation's waiting messages, hands every one to the Engine, and moves
 * the processed file into `in/done/` only after `receive` has resolved. A file that is missing, malformed or written by
 * the agent stays where it is and counts as unreadable, so a stray file is visible in the Source's health instead of
 * vanishing. Stable Trigger ids make a replayed round harmless.
 */
export async function pollInbox(ctx: SourceContext, config: InboxConfig, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  let read = 0
  let unreadable = 0
  for (const conversation of config.conversations) {
    const { waiting, unreadable: bad } = await readConversation(config.root, conversation.id)
    unreadable += bad
    for (const { name, path, message } of waiting) {
      if (signal.aborted) throw new Error('The inbox Source stopped during the read')
      const trigger = inboxTrigger(message, conversation.id, time(message.at, (await stat(path)).mtime.toISOString()), config)
      if (!trigger) { await moveDone(inboxDir(config.root, conversation.id), path, name); continue }
      await ctx.receive(trigger)
      await moveDone(inboxDir(config.root, conversation.id), path, name)
      read++
      const fact = { label: { zh: '对话', en: 'Conversation' }, value: conversation.id }
      for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { label: conversation.id, facts: { conversation: fact } })
    }
  }
  return { read, unreadable }
}

/** One message as the thread context reports it, agent replies included as bot messages. */
interface StoredMessage { id: string; from: string; at: string; text: string; bot?: true; reply_to?: string; url?: string; thread?: string }

/** Reads every message this conversation holds, waiting, done, and the agent's replies, oldest first. */
async function readThreadMessages(root: string, conversation: string): Promise<StoredMessage[]> {
  const messages: StoredMessage[] = []
  const folders = [join(inboxDir(root, conversation)), join(inboxDir(root, conversation), 'done'), outDir(root, conversation)]
  for (const folder of folders) {
    if (!existsSync(folder)) continue
    for (const name of (await readdir(folder)).filter(name => name.endsWith('.json')).sort()) {
      try {
        const parsed = MessageSchema.parse(JSON.parse(await readFile(join(folder, name), 'utf8')))
        messages.push({ id: parsed.id, from: parsed.from, text: parsed.text, ...(parsed.bot || parsed.from === INBOX_AGENT_FROM ? { bot: true as const } : {}),
          ...(parsed.reply_to ? { reply_to: parsed.reply_to } : {}), ...(parsed.url ? { url: parsed.url } : {}), ...(parsed.thread ? { thread: parsed.thread } : {}),
          at: time(parsed.at, (await stat(join(folder, name))).mtime.toISOString()) })
      } catch { /* a stray file is not thread context */ }
    }
  }
  return messages.sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : (a.at < b.at ? -1 : 1)))
}

export const inboxKind: SourceKind<InboxConfig> = {
  kind: 'inbox',
  title: { zh: '本地收件箱', en: 'Local inbox' },
  description: { zh: '监视本地目录中的消息文件：把消息 JSON 放进对话的 in/ 目录，回复写在 out/ 目录。无需任何外部账号。', en: 'Watches local message files: drop message JSON files into a conversation\'s in/ folder and read replies in out/. Needs no external account.' },
  schema: ConfigSchema,
  fields: [
    { key: 'root', type: 'text', label: { zh: '收件箱根目录', en: 'Inbox root' } },
    { key: 'agentName', type: 'text', label: { zh: '智能体名称', en: 'Agent name' }, hint: { zh: '消息的 to 字段写这个名字即视为向智能体喊话', en: 'A message whose "to" field names this addresses the agent' } },
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[A-Za-z0-9_-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @', en: 'Addressed only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['inbox'],
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendInbox,
    link: address => ({ url: address.url ?? '',
      label: { zh: `收件箱对话 ${address.conversation}`, en: `Inbox conversation ${address.conversation}` } }),
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    read: async (_commands, trigger, part, cursor, config) => {
      const conversation = String(trigger.meta.conversation ?? '')
      const all = await readThreadMessages(config.root, conversation)
      const root = String(trigger.meta.root ?? '')
      const messages = part === 'thread' ? all.filter(item => item.id === root || item.thread === root)
        : part === 'root' ? all.filter(item => item.id === root) : all.filter(item => item.id === String(trigger.meta.replyTo ?? ''))
      const offset = Number(cursor ?? 0) || 0
      const page = messages.slice(offset, offset + PAGE_SIZE)
      return { messages: page.map(({ thread: _thread, ...item }) => item),
        ...(offset + PAGE_SIZE < messages.length ? { next: String(offset + PAGE_SIZE) } : {}), body: { messages: page } }
    },
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人把消息的 to 字段写成 agent（或配置的智能体名称）。', en: 'Someone on the list sets the message\'s "to" field to the agent (or the configured agent name).' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return { id: conversation.id, label: conversation.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 to 字段', en: 'Addressed only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_INBOX_CONVERSATION', description: {
      zh: '接下工单的收件箱对话；工单不是从这个来源来的时为空',
      en: 'The inbox conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_INBOX_CONVERSATION: trigger?.source === 'inbox' ? String(trigger.meta.conversation ?? '') : '' }),
  },
}

/**
 * Sends one reply as a JSON file in the conversation's `out/` folder, named by the message id, so a retried send finds
 * the file already there and succeeds without writing twice. The reply names the message it answers (`to`), the Thread
 * root it belongs to (`thread`), and the direct parent (`reply_to`), which keeps it inside the thread context. File
 * delivery never becomes permanent (`gone`); a write failure throws for the Outbox to retry.
 */
export async function sendInbox(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to, dir, thread } = message.channel.address
  if (!dir || !conversation) throw new Error('Missing inbox reply target')
  const folder = outDir(dir, conversation)
  await mkdir(folder, { recursive: true })
  const reply = { id: message.id, conversation, to, thread, reply_to: to, from: INBOX_AGENT_FROM, text: message.text,
    at: new Date().toISOString(), ...(message.ticketId ? { ticket_id: message.ticketId } : {}) }
  try { await writeFile(join(folder, `${message.id}.json`), `${JSON.stringify(reply, null, 2)}\n`, { flag: 'wx' }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'sent'
    throw error
  }
  return 'sent'
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('inbox', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<InboxConfig>('inbox')
    if (!config) ctx.report('inbox', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollInbox(ctx, config, signal)
        failures = 0
        ctx.report('inbox', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One failed round is retried on the next pass; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report('inbox', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 10) * 1000, undefined, { signal }).catch(() => {})
  }
}

export const name = 'dsh-superagent-inbox'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(inboxKind), 'inbox: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, inboxKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('inbox', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
