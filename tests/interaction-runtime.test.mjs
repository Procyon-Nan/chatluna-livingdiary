import assert from 'node:assert/strict'
import test from 'node:test'
import { NoProviderError } from '@chatluna/ai'
import { QzoneNotFoundError, QzoneValidationError } from 'qzone-sdk'
import { AutoInteractionRuntime } from '../lib/auto-interaction/runtime.js'

const epoch = Date.parse('2026-11-12T12:00:00Z')
const time = seconds => new Date(epoch + seconds * 1000).toISOString()
const user = id => ({ id, nickname: id })
function comment(id, author = '200', options = {}) {
    return { id, author: user(author), content: '评论 ' + id, createdAt: time(1), kind: 'comment',
        parentId: null, threadRoot: null, replyTo: null, replyToUser: null, ...options }
}
function post(id, authorId, comments = [], seconds = -200) {
    return { id, authorId, author: user(authorId), content: '动态 ' + id, createdAt: time(seconds),
        comments, commentsComplete: true, media: [], likeCount: 0, commentCount: comments.length, liked: false }
}
function fixture(options = {}) {
    const rows = new Map()
    const self = post('self', '100')
    rows.set(self.id, self)
    const own = [self], friends = [], replies = [], comments = [], decisions = []
    const deps = {
        now: () => new Date(epoch),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        isBotOnline: () => true, getAccountId: () => '100',
        listFeedPage: async ({ scope, limit }) => ({ items: (scope === 'self' ? own : friends).slice(0, limit), nextCursor: null }),
        getPost: async ({ post }) => {
            if (!rows.has(post.id)) throw new QzoneNotFoundError('missing')
            return rows.get(post.id)
        },
        async comment({ post, content, signal }) {
            signal.throwIfAborted()
            const root = comment('me', '100')
            rows.get(post.id).comments.push(root)
            comments.push({ post: post.id, content })
            return { outcome: 'verified', comment: root }
        },
        async reply({ post, comment, content, signal }) {
            signal.throwIfAborted()
            replies.push({ post: post.id, target: comment.id, content })
            return { outcome: 'unknown' }
        },
        persona: async () => ({ persona: '人设', assistantLabel: '角色' }),
        async decide(input) { decisions.push(input); return { action: 'publish', content: '回应' } }
    }
    const runtime = new AutoInteractionRuntime(deps, {
        enableFriendPostComment: false, whitelistEnabled: false, allowIds: new Set(), monitorLimit: 10,
        maxWritesPerRound: 5, ...options
    })
    return { rows, own, self, friends, replies, comments, deps, decisions, runtime }
}

test('自己空间只监控真实 SDK 当前账号的个人主页；混入别人的帖子不会收到无关评论回复', async t => {
    const { QzoneClient } = await import('qzone-sdk')
    const { QzoneManager } = await import('../lib/qzone/manager.js')
    const f = fixture()
    let acquires = 0
    const requests = []
    const page = { msglist: ['100', '200'].map(uin => ({ tid: uin, uin, content: '动态' })) }
    const manager = new QzoneManager({
        acquire: async () => { acquires++; return { accountId: '100', cookies: 'p_skey=test' } },
        createClient: session => new QzoneClient({ session, fetch: async url => {
            const request = new URL(url)
            requests.push([request.pathname, request.searchParams.get('hostuin')])
            const html = '<script>window.shine0callback=function(){return "ab"};var FrontPage={data:' +
                JSON.stringify([null, { data: page }]) + '};</script>'
            return new Response(html)
        } }),
        currentBot: () => ({ selfId: '100', platform: 'onebot' }), logger: f.deps.logger,
        rebind: { minIntervalSeconds: 0, backoffSeconds: 1, maxBackoffSeconds: 10, maxConsecutiveFailures: 1 }
    })
    t.after(() => manager.close())
    f.deps.listFeedPage = query => manager.listFeedPage(query)
    f.deps.getAccountId = () => manager.status().client.accountId
    const own = post('100', '100'), foreign = post('200', '200')
    f.rows.set(own.id, own)
    f.rows.set(foreign.id, foreign)
    await f.runtime.runRound()
    assert.equal(f.runtime.report.phase, 'ready')
    assert.deepEqual([...f.runtime.state.monitoredPosts.keys()], ['100:100'])
    own.comments.push(comment('owned', '300'))
    foreign.comments.push(comment('unrelated', '300'))
    await f.runtime.runRound()
    assert.deepEqual(f.replies.map(r => r.target), ['owned'])
    assert.equal(acquires, 1)
    assert.deepEqual(requests, Array(2).fill(['/mqzone/profile', '100']))
})

test('已删除动态不阻断基线或扫描；临时网络错误保留下一轮重试', async () => {
    const f = fixture()
    f.own.unshift(post('gone-before-start', '100'))
    await f.runtime.runRound()
    assert.equal(f.runtime.report.phase, 'ready')
    assert.deepEqual([...f.runtime.state.monitoredPosts.keys()], ['100:self'])
    const valid = post('valid', '100', [comment('new-on-valid')], 3)
    f.own.unshift(post('gone-after-start', '100', [], 2), valid)
    f.rows.set(valid.id, valid)
    const read = f.deps.getPost
    let first = true
    f.deps.getPost = request => {
        if (request.post.id === valid.id && first) { first = false; throw Error('network') }
        return read(request)
    }
    await f.runtime.runRound()
    assert.equal(f.runtime.report.lastError, 'round-read')
    await f.runtime.runRound()
    assert.deepEqual(f.replies.map(r => r.target), ['new-on-valid'])
    assert.equal(f.runtime.state.monitoredPosts.has('100:gone-after-start'), false)
})

test('互动模型不可用时整轮暂停；恢复后再处理待回复的评论', async () => {
    const f = fixture()
    await f.runtime.runRound()
    f.self.comments.push(comment('a'), comment('b'))
    const available = f.deps.decide
    let attempts = 0
    f.deps.decide = async () => { attempts++; throw new NoProviderError({ message: '模型已移除' }) }
    await f.runtime.runRound()
    assert.equal(attempts, 1)
    assert.equal(f.runtime.report.lastError, 'model-unavailable')
    assert.equal(f.runtime.report.pendingTriggers, 2)
    assert.equal(f.replies.length, 0)
    f.deps.decide = available
    await f.runtime.runRound()
    assert.deepEqual(f.replies.map(reply => reply.target), ['a', 'b'])
})

test('基线等选中账号上线；已有评论、基线时刻以前的迟到评论、自己和白名单外用户均不触发', async () => {
    const f = fixture({ whitelistEnabled: true, allowIds: new Set(['200']) })
    let online = false
    f.deps.isBotOnline = () => online
    f.self.comments.push(comment('old'))
    await f.runtime.runRound()
    assert.equal(f.runtime.report.phase, 'waiting-bot')
    online = true
    await f.runtime.runRound()
    f.self.comments.push(comment('late', '200', { createdAt: time(-1) }), comment('self', '100'), comment('no', '300'), comment('new'))
    await f.runtime.runRound()
    await f.runtime.runRound()
    assert.deepEqual(f.replies.map(r => r.target), ['new'])
})

test('不完整的评论快照不推进；同一快照只处理一次，每轮写入不超过上限', async () => {
    const f = fixture({ maxWritesPerRound: 1 })
    await f.runtime.runRound()
    f.self.comments.push(comment('a'), comment('b'))
    f.self.commentsComplete = false
    await f.runtime.runRound()
    assert.equal(f.runtime.report.round.incompleteSnapshots, 1)
    assert.deepEqual(f.replies, [])
    f.self.commentsComplete = true
    await f.runtime.runRound()
    assert.equal(f.runtime.report.pendingTriggers, 1)
    await f.runtime.runRound()
    await f.runtime.runRound()
    assert.deepEqual(f.replies.map(r => r.target), ['a', 'b'])
    const saved = f.self.comments
    f.self.comments = []
    await f.runtime.runRound()
    f.self.comments = saved
    await f.runtime.runRound()
    assert.deepEqual(f.replies.map(r => r.target), ['a', 'b'])
})

test('先评论新的好友动态，随后只跟进自己的评论串及允许的发言人，忽略无关线程与自己', async () => {
    const f = fixture({ enableFriendPostComment: true, whitelistEnabled: true, allowIds: new Set(['200', '300']) })
    const old = post('old', '200')
    f.friends.push(old)
    await f.runtime.runRound()
    const newer = post('friend', '200', [], 1)
    const no = post('no', '400', [], 1)
    const own = post('own', '100', [], 1)
    f.rows.set('friend', newer)
    f.friends.unshift(newer, no, own)
    await f.runtime.runRound()
    assert.deepEqual(f.comments.map(r => r.post), ['friend'])
    const root = { id: 'me', authorId: '100' }
    newer.comments.push(comment('other-root', '300'), comment('reply', '300', { kind: 'reply', threadRoot: root }),
        comment('wrong-thread', '300', { kind: 'reply', threadRoot: { id: 'other-root', authorId: '300' } }),
        comment('no-access', '400', { kind: 'reply', threadRoot: root }), comment('echo', '100', { kind: 'reply', threadRoot: root }))
    await f.runtime.runRound()
    assert.deepEqual(f.replies.map(r => r.target), ['reply'])
    assert.equal(f.decisions[1].activeComment.id, 'reply')
})

test('写之前刷新详情：已删除的好友动态出队、普通网络错误留待下轮，SDK 写失败绝不重发', async () => {
    const f = fixture({ enableFriendPostComment: true, monitorLimit: 0 })
    await f.runtime.runRound()
    const gone = post('gone', '200', [], 1)
    const newer = post('friend', '200', [], 1)
    f.rows.set(newer.id, newer)
    f.friends.push(gone, newer)
    let networkFailures = 1, attempted = 0
    f.deps.getPost = async ({ post }) => {
        if (!f.rows.has(post.id)) throw new QzoneNotFoundError('gone')
        if (networkFailures-- > 0) throw Error('network')
        return f.rows.get(post.id)
    }
    f.deps.comment = async () => { attempted++; throw Error('write failed') }
    await f.runtime.runRound()
    assert.equal(f.runtime.report.pendingTriggers, 1)
    await f.runtime.runRound()
    await f.runtime.runRound()
    assert.equal(f.runtime.report.pendingTriggers, 0)
    assert.equal(attempted, 1)
})

test('好友 Feed 每轮至多六页，游标失效重扫后已评论的帖子不会重发，同一时间戳能识别不同动态', async () => {
    const f = fixture({ enableFriendPostComment: true, monitorLimit: 0, maxWritesPerRound: 20 })
    await f.runtime.runRound()
    const posts = Array.from({ length: 7 }, (_, n) => post(String(n), '200', [], 20 - n))
    posts.forEach(p => f.rows.set(p.id, p))
    let evicted = true
    f.deps.listFeedPage = async ({ cursor }) => {
        const n = Number(cursor ?? 0)
        if (n === 6 && evicted) { evicted = false; throw new QzoneValidationError('cursor expired') }
        return { items: [posts[n]], nextCursor: n < 6 ? String(n + 1) : null }
    }
    for (let i = 0; i < 4; i++) await f.runtime.runRound()
    assert.deepEqual(f.comments.map(r => r.post).sort(), ['0','1','2','3','4','5','6'])
    const same = post('same-second', '200', [], 20)
    f.rows.set(same.id, same)
    f.deps.listFeedPage = async () => ({ items: [same, posts[0]], nextCursor: null })
    await f.runtime.runRound()
    assert.deepEqual(f.comments.slice(7).map(r => r.post), ['same-second'])
})

test('分页游标重复时不困在该页；下一轮重扫找到更新的帖子且不重发', async () => {
    const f = fixture({ enableFriendPostComment: true, monitorLimit: 0 })
    await f.runtime.runRound()
    const first = post('first', '200', [], 1)
    const latest = post('latest', '200', [], 2)
    f.rows.set(first.id, first)
    f.rows.set(latest.id, latest)
    const cursors = []
    f.deps.listFeedPage = async ({ cursor }) => {
        cursors.push(cursor)
        return { items: [first], nextCursor: 'same' }
    }
    await f.runtime.runRound()
    assert.deepEqual(cursors, [undefined, 'same'])
    f.deps.listFeedPage = async ({ cursor }) => {
        assert.equal(cursor, undefined)
        return { items: [latest, first], nextCursor: null }
    }
    await f.runtime.runRound()
    assert.deepEqual(f.comments.map(x => x.post), ['first', 'latest'])
})

test('基线读取失败不提交部分水位；缺失的首个完整快照仅作为基线，新回复从下一张快照开始', async () => {
    const f = fixture()
    const get = f.deps.getPost
    f.deps.getPost = async () => { throw Error('offline') }
    await f.runtime.runRound()
    assert.equal(f.runtime.report.phase, 'failed')
    assert.equal(f.runtime.report.baselineCompletedAt, null)
    f.deps.getPost = get
    f.self.commentsComplete = false
    f.self.comments.push(comment('historical'))
    await f.runtime.runRound()
    f.self.commentsComplete = true
    f.self.comments.push(comment('first-complete'))
    await f.runtime.runRound()
    assert.deepEqual(f.replies, [])
    f.self.comments.push(comment('newer'))
    await f.runtime.runRound()
    assert.deepEqual(f.replies.map(r => r.target), ['newer'])
})

test('好友动态评论没有所属机器人的明确楼层时不开始跟帖', async () => {
    for (const result of [{ outcome: 'accepted' }, { outcome: 'unknown' },
        { outcome: 'accepted', reference: { id: 'root', authorId: '999' } }]) {
        const f = fixture({ enableFriendPostComment: true })
        await f.runtime.runRound()
        const friend = post('f', '200', [], 1)
        f.rows.set(friend.id, friend)
        f.friends.push(friend)
        f.deps.comment = async () => result
        await f.runtime.runRound()
        assert.equal(f.runtime.report.monitoredPosts, 1)
        friend.comments.push(comment('new', '200', { kind: 'reply', threadRoot: { id: 'root', authorId: '999' } }))
        await f.runtime.runRound()
        assert.deepEqual(f.replies, [])
        assert.equal(f.decisions.length, 1)
    }
})

test('每轮写入有限时依次优先好友动态中的机器人评论串、自己的评论、好友新动态', async () => {
    const f = fixture({ enableFriendPostComment: true, maxWritesPerRound: 1 })
    await f.runtime.runRound()
    const friend = post('f', '200', [], 1)
    f.rows.set(friend.id, friend)
    f.friends.push(friend)
    await f.runtime.runRound()
    friend.comments.push(comment('thread', '201', { kind: 'reply', threadRoot: { id: 'me', authorId: '100' } }))
    f.self.comments.push(comment('own'))
    const extra = post('g', '200', [], 2)
    f.rows.set(extra.id, extra)
    f.friends.unshift(extra)
    for (let i = 0; i < 3; i++) await f.runtime.runRound()
    assert.deepEqual(f.decisions.map(x => x.trigger.kind), ['friend-post', 'friend-thread-reply', 'self-comment', 'friend-post'])
})

test('挂载时离线只等待；Satori 上线立即建立基线，定时轮询与实例卸载成对释放', async t => {
    const { registerAutoInteraction } = await import('../lib/auto-interaction/index.js')
    t.mock.timers.enable({ apis: ['setInterval'] })
    let online = false, reads = 0, dispose, onStatus
    const ctx = {
        logger: { debug() {}, info() {}, warn() {}, error: assert.fail },
        effect(fn) { dispose = fn() },
        on(event, fn) { assert.equal(event, 'bot-status-updated'); onStatus = fn }
    }
    const reports = { interaction: null }
    const qzone = {
        status: () => ({ bot: online ? { selfId: '100' } : null, client: { accountId: '100' } }),
        async listFeedPage() { reads++; return { items: [], nextCursor: null } }
    }
    const cfg = { personaPresetId: 'p', subModel: '@small', enableFriendPostComment: false, enableInteractionWhitelist: true,
        interactionAllowUserIds: ['200'], interactionMonitorPostLimit: 5, interactionMaxWritesPerRound: 3, interactionPollIntervalMinutes: 1 }
    registerAutoInteraction(ctx, cfg, qzone, reports)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reports.interaction().phase, 'waiting-bot')
    assert.equal(reads, 0)
    online = true
    onStatus()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reports.interaction().phase, 'ready')
    assert.equal(reads, 1)
    t.mock.timers.tick(60_000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reads, 2)
    await dispose()
    assert.equal(reports.interaction, null)
    t.mock.timers.tick(120_000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reads, 2)
})

test('上一轮未结束时共享同次工作；卸载中止在途决策并等待，不会继续评论', async () => {
    const f = fixture()
    await f.runtime.runRound()
    f.self.comments.push(comment('trigger'))
    const entered = Promise.withResolvers(), finish = Promise.withResolvers()
    let signal
    f.deps.decide = async (_input, current) => {
        signal = current
        entered.resolve()
        await finish.promise
        return { action: 'publish', content: '太迟' }
    }
    const first = f.runtime.runRound()
    await entered.promise
    assert.equal(f.runtime.runRound(), first)
    let stopped = false
    const stop = f.runtime.stop().then(() => { stopped = true })
    await Promise.resolve()
    assert.ok(signal.aborted)
    assert.equal(stopped, false)
    finish.resolve()
    await stop
    assert.deepEqual(f.replies, [])
    await f.runtime.runRound()
    assert.deepEqual(f.replies, [])
})
