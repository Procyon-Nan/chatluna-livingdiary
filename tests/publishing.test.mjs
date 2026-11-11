import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { Context } from 'cordis'
import * as diary from '../lib/index.js'
import Tools from '@chatluna/tool'
import Permissions from '@chatluna/permission'
import { registerPublishTool } from '../lib/publishing/tool.js'
import { publishPost } from '../lib/publishing/publish.js'

test('工具常驻目录，发帖时按本次请求者授权，并遵守框架的工具权限', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(Permissions, { rules: [] })
    await ctx.plugin(Tools)
    const writes = []
    const plugin = await ctx.plugin({ inject: ['tools'], apply(scope) {
        registerPublishTool(scope, { allowUserIds: ['Alice'] }, {
            async publish(post) { writes.push(post.content); return { outcome: 'verified' } }
        })
    } })
    const entry = () => ctx.tools.catalog().find(item => item.definition.name === 'qzone_publish')
    const definition = entry().definition
    const run = (speakers, args = {}, actor) => ctx.tools.execute({
        name: 'qzone_publish', args: { content: 'Hello', ...args }, speakers, actor, location: { platform: 'onebot' }
    })
    const alice = { user: 'Alice', addressed: true }, bob = { user: 'Bob', addressed: true }
    const denied = async (...args) => {
        const result = await run(...args)
        assert.equal(result.ok, false)
        assert.match(result.error.message, /白名单/)
    }

    await denied([bob])
    await denied([bob, { user: 'Alice' }], { for: 'Alice' })
    await denied([], {}, { platform: 'onebot', user: 'Alice' })
    await denied([{ ...alice, platform: 'discord' }])
    await denied([alice, bob], { for: 'Alice' })
    await denied([alice, { user: 'Bob' }], { for: 'Bob' })
    await denied([alice], {}, { platform: 'onebot', user: 'Bob' })
    await denied([alice, { user: 'Bob' }], { for: 'Bob' }, { platform: 'onebot', user: 'Alice' })
    await denied([alice], {}, { platform: 'discord', user: 'Alice' })
    assert.deepEqual(writes, [])
    assert.equal((await run([alice, { user: 'Bob' }])).value.outcome, 'verified')
    assert.equal((await run([alice], { for: 'Alice' })).value.outcome, 'verified')
    ctx.permissions.rule({ id: 'deny-publish', permission: 'tool:qzone_publish', effect: 'deny' })
    assert.equal((await run([alice])).ok, false)
    assert.deepEqual(writes, ['Hello', 'Hello'])
    assert.equal(entry().definition, definition)
    await plugin.dispose()
    assert.equal(entry(), undefined)
})

test('发布开关独立于白名单：空名单时目录可见但不能发帖，关闭后没有工具', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    ctx.provide('satori', { bots: [] })
    await ctx.plugin(Tools)
    const entry = () => ctx.tools.catalog().find(tool => tool.definition.name === 'qzone_publish')
    const plugin = await ctx.plugin(diary)
    assert.ok(entry())
    const result = await ctx.tools.execute({ name: 'qzone_publish', args: { content: 'Hello' },
        location: { platform: 'onebot' }, speakers: [{ user: 'Alice', addressed: true }] })
    assert.equal(result.ok, false)
    assert.match(result.error.message, /白名单/)
    await plugin.dispose()
    await ctx.plugin(diary, { enablePublishTool: false, allowUserIds: ['Alice'] })
    assert.equal(entry(), undefined)
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
