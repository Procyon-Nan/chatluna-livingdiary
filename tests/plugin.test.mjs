import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import { Session } from '@satorijs/core'
import Koishi from 'koishi'
import SchemaRegistry from '@chatluna/ui-schema-registry'
import * as diary from '../lib/index.js'

test('基础命令独立运行；日记随记忆服务启停并保留上次结果', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(Database)
    await ctx.plugin(Koishi, { prefix: [] })
    const preset = { id: 'diary', name: '星星', kind: 'character', status: 'ok' }
    ctx.provide('presets', { list: () => [preset], get: id => id === preset.id ? preset : undefined })
    ctx.provide('ai', {})
    ctx.provide('prompt', {})
    ctx.provide('chatluna', {})
    await ctx.plugin(SchemaRegistry)
    const plugin = await ctx.plugin(diary, { allowUserIds: ['10001'], personaPresetId: 'diary', mainModel: '@small' })
    const bot = { ctx, platform: 'onebot', selfId: '10000', toJSON: () => ({ platform: 'onebot', selfId: '10000' }) }
    async function run(userId, command = 'qzone.status') {
        const session = new Session(bot, {
            type: 'message', selfId: bot.selfId, platform: bot.platform, user: { id: userId },
            channel: { id: '12345', type: 0 }, message: { id: '1' }
        })
        Reflect.set(session, 'user', { authority: 1 })
        return (await session.execute(command, true)).join('')
    }

    assert.ok(ctx.$commander.get('qzone.status'))
    assert.match(await run('10002'), /未授权/)
    assert.match(await run('10001'), /登录态|机器人/)
    assert.equal(ctx.$commander.get('qzone.digest'), undefined)
    const options = await ctx.schemas.resolve('livingdiary-persona')
    assert.ok(options.list.some(option => option.value === 'diary' && option.meta.description === '星星'))

    let reads = 0
    const repository = {
        async listEntriesByPreset(id) {
            assert.equal(id, preset.id)
            reads++
            return []
        }
    }
    const memory = await ctx.plugin(ctx => { ctx.provide('livingmemory', { repository }) })
    await new Promise(resolve => setImmediate(resolve))
    assert.match(await run('10002', 'qzone.digest'), /未授权/)
    assert.equal(reads, 0)
    assert.match(await run('10001', 'qzone.digest'), /无记忆/)
    assert.equal(reads, 1)
    await memory.dispose()
    assert.equal(ctx.$commander.get('qzone.digest'), undefined)
    assert.match(await run('10001'), /手动.*无记忆/)
    await plugin.dispose()
    assert.equal(ctx.$commander.get('qzone.status'), undefined)
})
