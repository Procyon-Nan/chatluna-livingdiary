import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import { Session } from '@satorijs/core'
import Koishi from 'koishi'
import * as diary from '../lib/index.js'

test('基础命令无需模型服务；宿主按 QQ 账号鉴权，卸载时注销命令', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(Database)
    await ctx.plugin(Koishi, { prefix: [] })
    const plugin = await ctx.plugin(diary, { allowUserIds: ['10001'] })
    const bot = { ctx, platform: 'onebot', selfId: '10000', toJSON: () => ({ platform: 'onebot', selfId: '10000' }) }
    async function run(userId) {
        const session = new Session(bot, {
            type: 'message', selfId: bot.selfId, platform: bot.platform, user: { id: userId },
            channel: { id: '12345', type: 0 }, message: { id: '1' }
        })
        Reflect.set(session, 'user', { authority: 1 })
        return (await session.execute('qzone.status', true)).join('')
    }

    assert.ok(ctx.$commander.get('qzone.status'))
    assert.match(await run('10002'), /未授权/)
    assert.match(await run('10001'), /登录态|机器人/)
    await plugin.dispose()
    assert.equal(ctx.$commander.get('qzone.status'), undefined)
})
