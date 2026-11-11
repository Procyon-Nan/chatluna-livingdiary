import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'cordis'
import Prompt from '@chatluna/prompt'
import { chatKind } from '@chatluna/preset'
import { characterKind } from '@chatluna/engine-character'
import { runDailyDigest } from '../lib/daily-digest/workflow.js'
import { decideDigest } from '../lib/daily-digest/model.js'

const start = new Date(2026, 10, 11, 12)
const midnight = new Date(2026, 10, 11)
const settings = { presetId: 'p', model: '@large', memoryLimit: 100 }
const text = '第一段。\n\n' + '写得长一点。'.repeat(30)
const call = input => ({ type: 'tool-call', toolCallId: 'result', toolName: 'publish_daily_digest', input })
const result = input => ({ toolCalls: [call(input)], content: [call(input)] })
const quiet = { info() {}, warn() {}, error() {} }

async function fixture(t, kind = 'chat') {
    const cordis = new Context()
    await cordis.plugin(Prompt)
    t.after(() => cordis.fiber.dispose())
    cordis.prompt.variable({ name: 'display', mutable: false }, ({ env }) => env.botName)
    const blocks = [{ id: 'p', content: '人设：{display}', order: 0, enabled: true, zone: 'system', role: 'system' },
        { id: 'history', content: '这不是本次群聊', order: 1, enabled: true, zone: 'context', role: 'user' }]
    const data = kind === 'character' ? { persona: '人设：{display}', style: '悠闲', example: '你好。', context: '这不是本次群聊' }
        : { blocks }
    const preset = { id: 'p', name: '人设 A', kind, status: 'ok', data }
    const calls = [], writes = [], reads = []
    const rows = Array.from({ length: 120 }, (_, i) => ({
        status: 'active', createdAt: new Date(+midnight + i * 60000), type: 'plan', content: `记忆[${i}]`, sentiment: '愉快'
    })).reverse()
    const ctx = { logger: quiet, prompt: cordis.prompt,
        presets: { get: id => id === preset.id ? preset : undefined, blocks: p => (p.kind === 'chat' ? chatKind : characterKind).blocks(p.id, p.data) },
        get: () => ({ repository: { listEntriesByPreset(id) { reads.push(id); return rows } } }),
        chatluna: { chat(input) { calls.push(input); return Promise.resolve(result({ action: 'publish', content: text })) } }
    }
    const qzone = { async publish(input) { writes.push(input); return { outcome: 'verified' } } }
    const run = (overrides = {}, signal = new AbortController().signal) => runDailyDigest(ctx, qzone,
        { ...settings, ...overrides }, 'manual', signal, start)
    return { ctx, qzone, rows, preset, reads, calls, writes, run }
}

for (const kind of ['chat', 'character']) {
    test(`${kind} 预设的渲染和当日取材：按创建时间取最近 100 条，整段正文只写一次`, async t => {
        const api = await fixture(t, kind)
        const base = { ...api.rows[0], content: '排除项', updatedAt: start }
        api.rows.unshift({ ...base, status: 'archived' }, { ...base, createdAt: new Date(+midnight - 1) },
            { ...base, createdAt: new Date(+start + 1) })
        const { result: outcome } = await api.run()
        assert.equal(outcome, 'published')
        assert.deepEqual(api.reads, ['p'])
        assert.equal(api.calls.length, 1)
        const request = api.calls[0]
        assert.equal(request.model, '@large')
        assert.match(request.system, /人设：人设 A/)
        if (kind === 'character') assert.match(request.system, /悠闲[\s\S]*你好。/)
        assert.doesNotMatch(request.system, /\{display\}|这不是本次群聊/)
        assert.deepEqual(request.toolSpecs.map(x => x.name), ['publish_daily_digest'])
        const prompt = request.messages[0].content[0].text
        assert.doesNotMatch(prompt, /排除项/)
        assert.deepEqual([...prompt.matchAll(/记忆\[(\d+)\]/g)].map(m => +m[1]), Array.from({ length: 100 }, (_, i) => i + 20))
        assert.match(prompt, /计划\|情绪:愉快/)
        assert.equal(api.writes.length, 1)
        assert.equal(api.writes[0].content, text)
    })
}

test('无有效预设、读记忆失败或无记忆时均不调用模型或发布；无法渲染的变量不会进入模型', async t => {
    const api = await fixture(t)
    assert.equal((await api.run({ presetId: 'missing' })).result, 'preset-missing')
    assert.deepEqual(api.reads, [])
    api.preset.data.blocks[0].content = '{not_registered}'
    assert.equal((await api.run()).result, 'preset-missing')
    api.rows.length = 0
    assert.equal((await api.run()).result, 'skipped-empty')
    api.ctx.get = () => ({ repository: { listEntriesByPreset() { throw Error('read failed') } } })
    assert.equal((await api.run()).result, 'failed')
    assert.deepEqual(api.calls, [])
    assert.deepEqual(api.writes, [])
})

test('当日窗口包含本地零点和任务开始时刻，不包含前一天或任务开始之后', async t => {
    const api = await fixture(t)
    api.rows.length = 0
    for (const [label, time] of [['昨夜', +midnight - 1], ['本地零点', +midnight], ['开始时刻', +start], ['未来', +start + 1]]) {
        api.rows.push({ type: 'plan', status: 'active', createdAt: new Date(time), content: label })
    }
    await api.run()
    const body = api.calls[0].messages[0].content[0].text
    assert.match(body, /本地零点[\s\S]*开始时刻/)
    assert.doesNotMatch(body, /昨夜|未来/)
})

test('当天仅整理或编辑了旧记忆时，日记跳过，不调用模型也不发帖', async t => {
    const api = await fixture(t)
    api.rows.length = 0
    api.rows.push({
        type: 'fact', status: 'active', content: '今天修订的旧事',
        createdAt: new Date(+midnight - 1), updatedAt: start
    })
    assert.equal((await api.run()).result, 'skipped-empty')
    assert.equal(api.calls.length, 0)
    assert.equal(api.writes.length, 0)
})

test('日记模型可跳过；空间已受理、结果未知和写失败分别报告，不重发', async t => {
    const api = await fixture(t)
    api.ctx.chatluna.chat = () => Promise.resolve(result({ action: 'skip' }))
    assert.equal((await api.run()).result, 'skipped-by-model')
    assert.deepEqual(api.writes, [])
    api.ctx.chatluna.chat = () => Promise.resolve(result({ action: 'publish', content: text }))
    let writes = 0
    for (const outcome of ['accepted', 'unknown', 'publish-failed']) {
        api.qzone.publish = async () => { writes++; if (outcome === 'publish-failed') throw Error('write error'); return { outcome } }
        assert.equal((await api.run()).result, outcome)
    }
    assert.equal(writes, 3)
})

test('格式错误带工具反馈纠正；模型异常共用七次预算，两次之间等五秒', async () => {
    const options = { systemPrompt: 'task', inputPrompt: 'data' }
    const signal = new AbortController().signal
    const requests = [], delays = []
    const ask = (fn) => decideDigest({ chatluna: { chat(data) { requests.push(data); return Promise.resolve().then(fn) } } },
        '@large', options, signal, false, async ms => { delays.push(ms) })
    await assert.rejects(ask(() => { if (requests.length % 2) return result({ action: 'publish' }); throw Error('network') }), /7 次.*content/)
    assert.equal(requests.length, 7)
    assert.deepEqual(delays, Array(6).fill(5000))
    assert.deepEqual(requests[1].messages.map(m => m.role), ['user', 'assistant', 'tool'])
    assert.match(requests[1].messages[2].content[0].output.value, /content/)
    assert.deepEqual(await ask(() => result({ action: 'skip' })), { action: 'skip' })
    await assert.rejects(ask(() => { throw Object.assign(Error('SECRET'), { code: 'NO_MODEL' }) }), error =>
        error.message.includes('NO_MODEL') && !error.message.includes('SECRET'))
})

test('停用会中止在途模型与等待登录的发布；已提交的写结果仍保留', async t => {
    const api = await fixture(t)
    const first = new AbortController()
    let began
    const called = new Promise(resolve => { began = resolve })
    api.ctx.chatluna.chat = () => {
        let stop
        const p = new Promise((_, reject) => { stop = reject })
        began()
        return Object.assign(p, { abort() { stop(new Error('aborted')) } })
    }
    const pending = api.run({}, first.signal)
    await called
    first.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.deepEqual(api.writes, [])
    const second = new AbortController()
    api.ctx.chatluna.chat = () => Promise.resolve(result({ action: 'publish', content: text }))
    api.qzone.publish = async ({ signal }) => {
        assert.equal(signal, second.signal)
        second.abort()
        signal.throwIfAborted()
    }
    await assert.rejects(api.run({}, second.signal), { name: 'AbortError' })
    const third = new AbortController()
    api.qzone.publish = async () => { third.abort(); return { outcome: 'accepted' } }
    assert.equal((await api.run({}, third.signal)).result, 'accepted')
})
