import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'cordis'
import AI from '@chatluna/ai-runtime'
import * as verbs from '@chatluna/ai-runtime/ops'
import ChatLuna from '@chatluna/core'
import { callModel } from '../lib/model.js'

test('模型已输出发布决定但随后报错或被截断时，不采纳该决定', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(ChatLuna)
    await ctx.plugin(AI)
    await ctx.plugin(verbs)
    const block = { type: 'tool-call', toolCallId: '1', toolName: 'submit_qzone_interaction',
        input: { action: 'publish', content: '你好' } }
    let finish
    ctx.ai.provide('local', { id: 'local', chat: id => ({
        id, spec: 'v1', modality: 'chat', provider: 'local', caps: () => ({}),
        async *stream() {
            yield { type: 'start', warnings: [] }
            yield { type: 'block-start', index: 0, kind: 'tool-call' }
            yield { type: 'block-end', index: 0, block }
            yield { type: 'finish', reason: finish }
        }
    }) })
    const messages = [{ role: 'user', content: [{ type: 'text', text: '互动决策' }] }]
    const generate = () => callModel(ctx, { model: 'local:test', messages, cache: false }, new AbortController().signal)
    for (const kind of ['stop', 'tool-calls']) {
        finish = { kind }
        assert.deepEqual((await generate()).toolCalls, [block])
    }
    for (const [kind, code] of [['error', 'TRANSPORT'], ['aborted', 'ABORTED']]) {
        finish = { kind, failure: { code, message: '测试中止', retryable: false } }
        await assert.rejects(generate(), { code })
    }
    finish = { kind: 'max-tokens' }
    await assert.rejects(generate(), /长度上限/)
    finish = { kind: 'content-filter' }
    await assert.rejects(generate(), /内容过滤/)
})
