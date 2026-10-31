import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { apply as applyInbox, inboxKind, inboxTrigger, pollInbox, sendInbox, type InboxConfig } from '../src/sources/inbox.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const config: InboxConfig = { root: '', agentName: 'agent', conversations: [{ id: 'ops', listen: 'mentions' }, { id: 'town', listen: 'all' }], pollSeconds: 10 }
let root = ''

afterEach(() => { if (root) { rmSync(root, { recursive: true, force: true }); root = '' } })

/** A fresh inbox tree with the `ops` (mentions) and `town` (all) conversations, and the Source's full context. */
function host(overrides: Partial<SourceContextDeps> = {}) {
  root = mkdtempSync(join(tmpdir(), 'inbox-'))
  for (const conversation of config.conversations) mkdirSync(join(root, conversation.id, 'in'), { recursive: true })
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'inbox-db-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    policy: { sources: { inbox: { allowed: [{ id: 'alice', name: 'Alice' }] } } }, eval: { mode: 'auto' },
    sources: { inbox: { enabled: true, config: { ...config, root } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(inboxKind)
  const deployment = testDeployment()
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } },
    commands: undefined as never, sources, deployment, ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const ctx = sourceContextOf(parts, inboxKind)
  return { ...parts, ctx, engine, receive, sources, store, health: board.all }
}

/** Drops one message file into a conversation's `in/` folder. */
const drop = (conversation: string, id: string, fields: Record<string, unknown> = {}): string => {
  const path = join(root, conversation, 'in', `${id}.json`)
  writeFileSync(path, JSON.stringify({ id, from: 'alice', text: `hello from ${id}`, at: '2026-09-09T00:00:00.000Z', ...fields }))
  return path
}

describe('inbox source', () => {
  it('translates a message into a trigger keyed by conversation and message, and drops the agent\'s own', () => {
    const message = { id: 'm1', from: 'alice', text: 'hi', at: '2026-09-09T00:00:00.000Z', bot: false }
    const trigger = inboxTrigger(message, 'ops', '2026-09-09T00:00:00.000Z', config)!
    expect(trigger).toMatchObject({ id: key('inbox', 'ops', 'm1'), source: 'inbox', threads: [{ source: 'inbox', id: 'ops:m1' }],
      actor: { source: 'inbox', id: 'alice' }, human: true, at: '2026-09-09T00:00:00.000Z',
      channel: { source: 'inbox', thread: 'inbox:ops:m1', address: { conversation: 'ops', message: 'm1', dir: config.root, thread: 'm1' } },
      meta: { conversation: 'ops', messageId: 'm1', root: 'm1' } })
    expect(trigger).not.toHaveProperty('addressed')
    // The root of a reply is the message it follows; the reply keeps its own parent for context.
    const reply = inboxTrigger({ ...message, id: 'm2', thread: 'm1', reply_to: 'm1' }, 'ops', trigger.at, config)!
    expect(reply.threads[0]!.id).toBe('ops:m1')
    expect(reply.meta).toMatchObject({ root: 'm1', replyTo: 'm1' })
    // A message addressed to the agent carries the mention; the agent's own replies never re-enter.
    expect(inboxTrigger({ ...message, to: 'agent' }, 'ops', trigger.at, config)!.addressed).toBe('mention')
    expect(inboxTrigger({ ...message, from: 'dsh-superagent' }, 'ops', trigger.at, config)).toBeUndefined()
  })

  it('takes in what the folders hold, once, moves the files to done/, and keeps an unreadable file in place', async () => {
    const h = host()
    const config2: InboxConfig = { ...config, root }
    drop('ops', 'm1', { to: 'agent' })
    drop('town', 'm2')
    writeFileSync(join(root, 'ops', 'in', 'broken.json'), '{ not json')
    expect(await pollInbox(h.ctx, config2, new AbortController().signal)).toEqual({ read: 2, unreadable: 1 })
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(await h.receive.mock.results[1]!.value).toBe('stored')
    // The processed files moved to done/; the unreadable one stayed for a person to fix.
    expect(existsSync(join(root, 'ops', 'in', 'done', 'm1.json'))).toBe(true)
    expect(existsSync(join(root, 'town', 'in', 'done', 'm2.json'))).toBe(true)
    expect(existsSync(join(root, 'ops', 'in', 'broken.json'))).toBe(true)
    // An allowed sender who addresses the agent makes an explicit request.
    expect(h.engine.candidate(key('inbox', 'ops', 'm1'))?.strength).toBe('explicit')
    // A replayed round finds nothing new and re-reads nothing.
    expect(await pollInbox(h.ctx, config2, new AbortController().signal)).toEqual({ read: 0, unreadable: 1 })
    expect(h.receive).toHaveBeenCalledTimes(2)
    h.store.close()
  })

  it('never reads a conversation the configuration does not list, and evaluates an unaddressed message without explicit strength', async () => {
    const h = host()
    mkdirSync(join(root, 'elsewhere', 'in'), { recursive: true })
    drop('town', 'm1')
    drop('elsewhere', 'm9', { to: 'agent' })
    // The round reads only the listed conversations; `elsewhere` waits untouched.
    expect(await pollInbox(h.ctx, { ...config, root }, new AbortController().signal)).toEqual({ read: 1, unreadable: 0 })
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(existsSync(join(root, 'elsewhere', 'in', 'm9.json'))).toBe(true)
    // An unaddressed message in a mentions conversation is stored, but carries no explicit strength.
    drop('ops', 'm2')
    expect(await pollInbox(h.ctx, { ...config, root }, new AbortController().signal)).toEqual({ read: 1, unreadable: 0 })
    expect(await h.receive.mock.results.at(-1)!.value).toBe('stored')
    expect(h.engine.candidate(key('inbox', 'ops', 'm2'))?.strength).not.toBe('explicit')
    h.store.close()
  })

  it('writes each reply file once by id, and throws for a reply without a target', async () => {
    const h = host()
    const address = { conversation: 'ops', message: 'm1', dir: root, thread: 'm1' }
    const message = { id: key('inbox', 'ack', '1'), channel: { source: 'inbox', thread: 'inbox:ops:m1', address }, text: 'On it.', kind: 'acknowledgement' as const }
    await expect(sendInbox(h.ctx, message)).resolves.toBe('sent')
    const path = join(root, 'ops', 'out', `${message.id}.json`)
    const first = readFileSync(path, 'utf8')
    expect(JSON.parse(first)).toMatchObject({ id: message.id, conversation: 'ops', to: 'm1', thread: 'm1', reply_to: 'm1', from: 'dsh-superagent', text: 'On it.' })
    // A retried send finds the file and does not rewrite it.
    await expect(sendInbox(h.ctx, message)).resolves.toBe('sent')
    expect(readFileSync(path, 'utf8')).toBe(first)
    await expect(sendInbox(h.ctx, { ...message, id: 'x', channel: { ...message.channel, address: { conversation: 'ops', message: 'm1' } } })).rejects.toThrow('Missing inbox reply target')
    h.store.close()
  })

  it('reads a thread\'s messages with the agent\'s replies, and pages them', async () => {
    const h = host()
    drop('ops', 'm1', { to: 'agent' })
    drop('ops', 'm2', { thread: 'm1', reply_to: 'm1', text: 'second' })
    await pollInbox(h.ctx, { ...config, root }, new AbortController().signal)
    const ack = { id: 'r-ack', channel: { source: 'inbox', thread: 'inbox:ops:m1', address: { conversation: 'ops', message: 'm1', dir: root, thread: 'm1' } }, text: 'On it: hello.', kind: 'acknowledgement' as const }
    await sendInbox(h.ctx, ack)
    const trigger = h.ctx.triggers.get(key('inbox', 'ops', 'm1'))!
    const context = inboxKind.threadContext!
    const page = await context.read(h.ctx.commands, trigger, 'thread', undefined, { ...config, root })
    // The reply file is the newest message, so it sorts last by time.
    expect(page.messages.map(item => item.id)).toEqual(['m1', 'm2', 'r-ack'])
    expect(page.messages.find(item => item.id === 'r-ack')).toMatchObject({ from: 'dsh-superagent', bot: true })
    expect(page.next).toBeUndefined()
    // A page cut short names its cursor; the parent part reads one message.
    const short = await context.read(h.ctx.commands, trigger, 'thread', '0', { ...config, root })
    expect(short.messages).toHaveLength(3)
    const parent = await context.read(h.ctx.commands, h.ctx.triggers.get(key('inbox', 'ops', 'm2'))!, 'parent', undefined, { ...config, root })
    expect(parent.messages.map(item => item.id)).toEqual(['m1'])
    h.store.close()
  })

  it('registers its kind, waits for setup, and unregisters on disposal', async () => {
    const run = async (state: 'paused' | 'ready', overrides: Partial<SourceContextDeps> = {}) => {
      const value = host(overrides)
      const board = new HealthBoard()
      const sources = new SourceRegistry(() => value.store.settings(), board)
      const parts = { ...value, sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf({ ...value, sources }, kind) }
      const health = board.all
      const disposers: (() => unknown)[] = []
      applyInbox({ orchestrator: parts, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      // The entry starts as `starting`; wait until the loop reports the state this run expects.
      await vi.waitFor(() => expect(health.inbox?.state).toBe(state))
      const registered = sources.kind('inbox')
      // Snapshot the health before disposal clears the registered entries.
      const snapshot = { ...health }
      for (const dispose of disposers) await dispose()
      return { registered, snapshot, sources }
    }
    const waiting = await run('paused', { configured: () => false })
    expect(waiting.registered).toBe(inboxKind)
    expect(waiting.snapshot.inbox).toEqual({ state: 'paused', detail: 'Waiting for the deployment check', code: 'setupPending' })
    const ready = await run('ready')
    expect(ready.snapshot.inbox).toMatchObject({ state: 'ready' })
    expect(ready.sources.kind('inbox')).toBeUndefined()
  })

  it('lists its policy admission rows from the configuration', () => {
    const rows = inboxKind.policy!.rows!({ root: '/x', conversations: [{ id: 'ops', listen: 'mentions' }, { id: 'town', listen: 'all' }] })
    expect(rows.map(row => row.id)).toEqual(['ops', 'town'])
    expect(rows[0]!.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false })
    expect(rows[1]!.cells).toEqual({ listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true })
  })
})
