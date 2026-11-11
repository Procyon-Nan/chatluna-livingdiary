import assert from 'node:assert/strict'
import test from 'node:test'
import { h } from 'koishi'
import { registerCommands } from '../../lib/commands/index.js'

function commands(service, allowUserIds = ['23'], reports = { digest: null }) {
    const actions = new Map()
    const ctx = {
        command(declaration, _desc, { owner }) {
            assert.equal(owner, 'livingdiary')
            return {
                usage() { return this },
                option() { return this },
                action(fn) { actions.set(declaration.split(' ')[0], fn); return this }
            }
        }
    }
    registerCommands(ctx, { allowUserIds, feedsDefaultLimit: 5 }, service, reports)
    return actions
}
const session = { userId: '23', platform: 'onebot' }

test('私聊和群聊命令都检查平台和 QQ 号，同号其他平台及无人白名单不访问空间', async () => {
    const inaccessible = new Proxy({}, { get() { throw Error('unexpected Qzone access') } })
    for (const [allow, user] of [
        [['23'], { ...session, platform: 'discord' }],
        [['23'], { ...session, userId: '24' }],
        [['23'], undefined],
        [[], session]
    ]) {
        const actions = commands(inaccessible, allow)
        for (const name of ['qzone.publish', 'qzone.status', 'qzone.feeds']) {
            assert.match(await actions.get(name)({ session: user }), /未授权/)
        }
    }
})

test('feeds 默认读自己的空间，可以指定目标 QQ，查询限定十条', async () => {
    const requests = []
    const listFeedPage = async query => {
        requests.push(query)
        return { items: [{ createdAt: null, author: { nickname: '用户' }, content: '动态正文', likeCount: 2, commentCount: 1, liked: false }] }
    }
    const feeds = commands({ listFeedPage }).get('qzone.feeds')
    assert.match(await feeds({ session }), /用户：动态正文/)
    await feeds({ session: { ...session, platform: 'milky' }, options: { target: '123' } }, 999)
    assert.deepEqual(requests, [{ scope: 'self', limit: 5 }, { scope: 'profile', userId: '123', limit: 10 }])
})

test('空间昵称和正文中的消息标签只按文字显示', async () => {
    const nickname = '<at type="all"/>'
    const content = 'A & B <img src="https://example.invalid/a"/>'
    const feeds = commands({ listFeedPage: async () => ({ items: [
        { createdAt: null, author: { nickname }, content, likeCount: 0, commentCount: 0 }
    ] }) }).get('qzone.feeds')
    const elements = h.normalize(await feeds({ session }))
    assert.deepEqual(elements.map(e => e.type), ['text'])
    assert.ok(elements[0].attrs.content.includes(nickname + '：' + content))
})

test('状态展示最近一次日记的触发方式、时间和处理结果', async () => {
    const reports = { digest: null }
    const service = { status: () => ({ bot: null, client: { initialized: false, rebind: { consecutiveFailures: 0 } } }) }
    const status = commands(service, ['23'], reports).get('qzone.status')
    assert.match(await status({ session }), /每日日记：未运行/)
    reports.digest = { trigger: 'scheduled', triggeredAt: '2026-11-11T03:00:00.000Z', result: 'skipped-empty', detail: '当日无记忆' }
    assert.match(await status({ session }), /每日日记：.*2026.*（定时）：跳过（当日无记忆）/)
})

test('手动发布仅读取顶层文本和配图，表情及引用中的配图不会发布', async () => {
    const actions = new Map()
    const bodies = []
    const lookups = []
    const ctx = {
        command(decl) { return {
            usage() { return this }, option() { return this },
            action(fn) { actions.set(decl.split(' ')[0], fn); return this }
        } },
        get(key) {
            assert.equal(key, 'chatluna_storage')
            return { async getTempFile(id) { lookups.push(id); return { name: 'a.png', size: 1, data: Buffer.from([7]) } } }
        }
    }
    registerCommands(ctx, { allowUserIds: ['23'] }, { async publish(req) { bodies.push(req); return { outcome: 'verified' } } }, { digest: null })
    const response = await actions.get('qzone.publish')({ session }, [
        h.text('测试内容'), h('face', {}, h.image('https://example.invalid/face.png')),
        h('quote', {}, h.text('引用正文'), h.image('https://example.invalid/quoted.png')), h.image('storage://a')
    ])
    assert.match(response, /发布成功/)
    assert.deepEqual(lookups, ['a'])
    assert.deepEqual(bodies, [{ content: '测试内容', images: [{ name: 'a.png', data: Buffer.from([7]) }] }])
})
