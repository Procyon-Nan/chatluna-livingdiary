import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { Context } from 'cordis'
import { Session } from '@chatluna/session'
import Tools from '@chatluna/tool'
import Permissions from '@chatluna/permission'
import { registerPublishTool } from '../lib/publishing/tool.js'
import { publishPost } from '../lib/publishing/publish.js'

test('真实工具调度仅允许本轮请求者本人发布，不能向同轮其他人借权限', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    const session = new Session('diary-tool-test')
    const location = { platform: 'onebot' }
    let speakers = []
    let writes = 0
    const agent = { session, options: { location }, speakers: () => speakers }
    ctx.provide('agents')
    ctx.set('agents', { list: () => [agent] })
    ctx.provide('permissions')
    ctx.set('permissions', { define() {}, actorOf: Permissions.prototype.actorOf, levelOf: () => 1 })
    await ctx.plugin(Tools)
    const plugin = await ctx.plugin({
        name: 'livingdiary-test',
        inject: ['tools', 'agents'],
        apply(ctx) {
            registerPublishTool(ctx, { allowUserIds: ['Alice'], enablePublishTool: true }, {
                async publish() { writes++; return { outcome: 'verified' } }
            })
        }
    })
    const run = (args = {}, actor) => ctx.tools.execute({
        name: 'qzone_publish', args: { content: 'Hello', ...args }, agent, location, speakers, actor
    })
    async function begin(users, target = agent) {
        speakers = users
        // 会话来源平台由 Agent 提供；跨平台定时唤醒由框架 wake.as 提供。
        const input = users.map(speaker => speaker.platform
            ? { source: { kind: 'plugin' }, meta: { wake: { as: speaker } } }
            : { source: { kind: 'user' }, content: [], meta: {
                sender: { id: speaker.user }, wake: { direct: speaker.addressed }
            } })
        await ctx.serial('agent/before-turn', { agent: target, turn: 1, input })
    }
    function visible() {
        return ctx.tools.list(agent).some(tool => tool.name === 'qzone_publish')
    }
    await begin([{ user: 'Bob', addressed: true }, { user: 'Alice' }])
    assert.equal(visible(), false)
    assert.equal((await run({ for: 'Alice' })).ok, false)
    await begin([])
    assert.equal((await run({}, { user: 'Alice', platform: 'onebot' })).ok, false)
    await begin([{ user: 'Alice', addressed: true, platform: 'discord' }])
    assert.equal(visible(), false)
    assert.equal((await run()).ok, false)
    await begin([{ user: 'Alice', addressed: true }, { user: 'Bob', addressed: true }])
    assert.equal(visible(), false)
    assert.equal((await run({ for: 'Alice' })).ok, false)
    await begin([{ user: 'Alice', addressed: true }, { user: 'Bob' }])
    assert.equal(visible(), true)
    assert.equal((await run({ for: 'Bob' })).value.outcome, 'failed')
    assert.equal((await run({}, { user: 'Bob', platform: 'onebot' })).value.outcome, 'failed')
    assert.equal((await run({ for: 'Bob' }, { user: 'Alice', platform: 'onebot' })).value.outcome, 'failed')
    assert.equal((await run({}, { user: 'Alice', platform: 'discord' })).value.outcome, 'failed')
    assert.equal(writes, 0)
    assert.equal((await run()).value.outcome, 'verified')
    assert.equal((await run({ for: 'Alice' })).value.outcome, 'verified')
    assert.equal(writes, 2)
    speakers = [{ user: 'Alice', addressed: true }, { user: 'Bob', addressed: true }]
    assert.equal((await run({ for: 'Alice' })).value.outcome, 'failed')
    assert.equal(writes, 2)
    assert.equal(ctx.tools.list().some(tool => tool.name === 'qzone_publish'), false)
    const other = { ...agent, session: new Session('other') }
    assert.equal(ctx.tools.list(other).some(tool => tool.name === 'qzone_publish'), false)
    await begin([{ user: 'Alice', addressed: true }], other)
    assert.equal(ctx.tools.list(other).some(tool => tool.name === 'qzone_publish'), true)
    ctx.emit('chatluna/agent-close', { agent: other })
    assert.equal(ctx.tools.list(other).some(tool => tool.name === 'qzone_publish'), false)
    ctx.emit('chatluna/agent-turn', { agent, reason: 'completed', steps: [] })
    assert.equal(visible(), false)
    await begin([{ user: 'Bob', addressed: true }])
    assert.equal((await run()).error.code, 'NOT_VISIBLE')
    await begin([{ user: 'Alice', addressed: true }])
    await ctx.serial('agent/turn-failed', { agent }, new Error('test failure'))
    assert.equal(visible(), false)
    await begin([{ user: 'Alice', addressed: true }])
    await plugin.dispose()
    assert.equal(visible(), false)
})

test('发布命令与工具共用图片读取；整批成功后只提交一次，不重发结果未知的写入', async t => {
    const requests = []
    const qzone = { publish: async request => { requests.push(request); return { outcome: 'unknown' } } }
    const ctx = {
        logger: { warn() {} },
        get: () => ({ getTempFile: async id => id === 'gone' ? null : {
            name: 'local.png', size: 2, data: Promise.resolve(Buffer.from('ab'))
        } })
    }
    const server = createServer((request, response) => {
        if (request.url.includes('missing')) response.writeHead(404).end()
        else response.end('cd')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const url = `http://127.0.0.1:${server.address().port}`
    const post = (content, images) => publishPost(ctx, qzone, { content, images })
    assert.equal((await post(' ', [])).outcome, 'failed')
    assert.equal((await post('', Array(10).fill('storage://ok'))).outcome, 'failed')
    assert.equal((await post('ok', ['storage://ok', 'storage://gone'])).outcome, 'failed')
    const missing = await post('ok', [url + '/missing?token=SECRET'])
    assert.match(missing.message, /过期/)
    assert.doesNotMatch(missing.message, /SECRET/)
    assert.equal(requests.length, 0)
    const result = await post(' 秋\n 天 ', ['storage://ok', '/files/local.png', url + '/hello%20there.png'])
    assert.deepEqual(requests.map(({ content, images }) => [content, images.map(i => [i.name, Buffer.from(i.data).toString()])]), [
        ['秋 天', [['local.png', 'ab'], ['local.png', 'ab'], ['hello there.png', 'cd']]]
    ])
    assert.equal(result.outcome, 'unknown')
    assert.match(result.message, /禁止自动重发/)
})
