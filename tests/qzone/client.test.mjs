import assert from 'node:assert/strict'
import test from 'node:test'
import { QzoneAuthError, QzoneCancelledError, QzoneClient } from 'qzone-sdk'
import { acquireQzoneCookies, adaptMilkyCookieBot, adaptOneBotCookieBot, selectCookieBotView, CookieAcquireError } from '../../lib/qzone/cookie-source.js'
import { QzoneManager, QzoneWriteAuthError } from '../../lib/qzone/manager.js'
import { RebindController, RebindRejectedError } from '../../lib/qzone/rebind.js'
import { createQzoneService } from '../../lib/qzone/service.js'
import { publishPost } from '../../lib/publishing/publish.js'

const grant = { accountId: '5678', cookies: 'p_skey=test', domain: 'qzone.qq.com' }
const rebind = { minIntervalSeconds: 0, backoffSeconds: 2, maxBackoffSeconds: 3, maxConsecutiveFailures: 3 }
const logger = { info() {}, error() {}, warn() {} }
const auth = () => { throw new QzoneAuthError('expired') }

test('日记只认可回执 ID 对应的详情，列表唯一命中同文也不算；每次只提交一次', async t => {
    const content = '今天的日记'
    for (const scenario of ['详情命中', '详情缺失', '同文命中', '列表为空', '回执不明']) {
        await t.test(scenario, async () => {
            const withId = scenario.startsWith('详情')
            const post = { tid: 'diary-id', uin: grant.accountId, content, created_time: Math.floor(Date.now() / 1000) }
            let writes = 0, detailReads = 0
            const manager = new QzoneManager({ logger, rebind, acquire: async () => grant,
                createClient: (session, observe) => new QzoneClient({ session, logger: observe, fetch: async url => {
                    const { pathname, searchParams } = new URL(url)
                    if (pathname.endsWith('emotion_cgi_publish_v6')) {
                        writes++
                        if (scenario === '回执不明') return new Response('invalid', { status: 500 })
                        return Response.json(withId ? { code: 0, tid: post.tid } : { code: 0 })
                    }
                    if (pathname.endsWith('emotion_cgi_msgdetail_v6')) {
                        detailReads++
                        assert.equal(searchParams.get('tid'), post.tid)
                        return Response.json(scenario === '详情命中' ? post : { code: -100 })
                    }
                    const msglist = scenario === '同文命中' ? [post] : []
                    return new Response('<script>window.shine0callback=function(){return "ab"};var FrontPage={data:' +
                        JSON.stringify([null, { data: { msglist } }]) + '};</script>')
                } })
            })
            try {
                assert.equal(await manager.publishDiary({ content }), scenario === '详情命中')
                assert.equal(writes, 1)
                assert.equal(detailReads, withId ? 1 : 0)
                if (scenario === '同文命中') {
                    // 同一份网络回包：SDK 普通发帖确实会因列表命中返回 verified。
                    assert.equal((await manager.publish({ content })).outcome, 'verified')
                }
            } finally { await manager.close() }
        })
    }
})

test('自动选在线 OneBot，其次 Milky；指定 selfId/协议后不借其他机器人的登录态', () => {
    const bots = [
        { platform: 'onebot', selfId: '1', status: 2 },
        { platform: 'milky', selfId: '2', status: 1 },
        { platform: 'onebot', selfId: '3', status: 1 }
    ]
    assert.equal(selectCookieBotView(bots, 'auto'), bots[2])
    assert.equal(selectCookieBotView(bots.slice(0, 2), 'auto'), bots[1])
    assert.equal(selectCookieBotView(bots, 'auto', '2'), bots[1])
    assert.equal(selectCookieBotView(bots, 'onebot', '1'), undefined)
})

test('协议获取 Cookie，跳过无票据域名，缺 uin 则以机器人登录账号初始化真实 SDK', async () => {
    for (const platform of ['onebot', 'milky']) {
        const domains = []
        let logins = 0
        const raw = {
            selfId: grant.accountId,
            internal: {
                async getCookies(domain) {
                    domains.push(domain)
                    const cookies = domains.length === 1 ? 'uin=123' : grant.cookies
                    return platform === 'milky' ? { cookies } : cookies
                },
                async getLoginInfo() {
                    logins++
                    return platform === 'milky' ? { uin: 5678 } : { user_id: 5678 }
                }
            }
        }
        const bot = platform === 'milky' ? adaptMilkyCookieBot(raw) : adaptOneBotCookieBot(raw)
        const session = await acquireQzoneCookies(bot)
        assert.deepEqual(domains, ['user.qzone.qq.com', 'qzone.qq.com'])
        assert.equal(logins, 1)
        assert.deepEqual(session, grant)
        const client = new QzoneClient({ session })
        try { assert.equal(client.getSessionInfo().accountId, grant.accountId) }
        finally { await client.close() }
    }
})

test('Cookie 域名全部失败时最多查一次登录账号，错误信息不泄露票据或适配器错误正文', async () => {
    let loginCount = 0
    let cookiesCount = 0
    const bot = {
        platform: 'onebot',
        getCookieHeader() {
            cookiesCount++
            if (cookiesCount === 2) throw Error('sensitive-data')
            return 'skey=private-ticket'
        },
        async getLoginUin() { loginCount++; return null }
    }
    await assert.rejects(acquireQzoneCookies(bot), error =>
        error instanceof CookieAcquireError && !/sensitive-data|private-ticket/.test(error.message))
    assert.equal(cookiesCount, 4)
    assert.equal(loginCount, 1)
})

test('状态不索取 Cookie，所选机器人离线时读操作不连接 SDK', async () => {
    const raw = { platform: 'onebot', status: 1, selfId: '1234', internal: {} }
    const service = createQzoneService({ satori: { bots: [raw] }, logger }, { platform: 'auto' })
    assert.equal(service.status().bot.selfId, '1234')
    assert.equal(service.status().client.initialized, false)
    raw.status = 0
    assert.equal(service.status().bot, null)
    await assert.rejects(service.listFeedPage({ scope: 'self' }), /没有可用/)
    await service.close()
})

test('空间账号必须是取 Cookie 的机器人，已绑定的账号下线后不切换到另一 QQ', async () => {
    const makeBot = (selfId, cookieUin) => ({
        selfId, platform: 'onebot', status: 1,
        internal: { getCookies: async () => 'skey=test; uin=o' + cookieUin }
    })
    const first = makeBot('123', '000123')
    const second = makeBot('456', '456')
    const service = createQzoneService({ satori: { bots: [first, second] }, logger }, { platform: 'auto' })
    // limit 在 SDK 发起网络请求前校验，可离线驱动实际 SDK 的登录初始化。
    await assert.rejects(service.listFeedPage({ scope: 'self', limit: 0 }), /limit/)
    assert.equal(service.status().bot.selfId, '123')
    assert.equal(service.status().client.accountId, '000123')
    first.status = 0
    assert.equal(service.status().bot, null)
    assert.equal(service.status().client.accountId, '000123')
    await service.close()

    const mismatched = adaptOneBotCookieBot(makeBot('123', '456'))
    await assert.rejects(acquireQzoneCookies(mismatched), /登录账号与所选机器人不一致/)
})

test('并发失效读取共享初始化和续绑，使用 SDK 账号及票据重放各自的一次读取', async () => {
    let acquires = 0
    let creates = 0
    let reads = 0
    const sessions = []
    const page = { items: [] }
    const client = {
        getSessionInfo() { return { accountId: grant.accountId } },
        async listFeeds() { if (++reads <= 2) auth(); return page },
        async updateSession(session) { sessions.push(session) },
        async close() {}
    }
    const manager = new QzoneManager({
        acquire: async () => { acquires++; return grant },
        createClient: session => { creates++; sessions.push(session); return client },
        logger, rebind
    })
    const results = await Promise.all([manager.listFeedPage({ scope: 'self' }), manager.listFeedPage({ scope: 'self' })])
    assert.deepEqual(results, [page, page])
    assert.deepEqual(sessions, Array(2).fill({ accountId: grant.accountId, cookies: grant.cookies }))
    assert.deepEqual([acquires, creates, reads], [2, 1, 4])
    await manager.close()
})

test('持续鉴权失败的读操作仅重放一次；普通读取异常不续绑', async () => {
    for (const failure of [new QzoneAuthError('expired'), Error('network')]) {
        let reads = 0
        let updates = 0
        const manager = new QzoneManager({
            acquire: async () => grant,
            createClient: () => ({
                getPost() { reads++; throw failure },
                async updateSession() { updates++ },
                async close() {}
            }), logger, rebind
        })
        await assert.rejects(manager.getPost({}), error => error === failure)
        assert.deepEqual([reads, updates], failure instanceof QzoneAuthError ? [2, 1] : [1, 0])
        await manager.close()
    }
})

test('轮询在等待读取权限或续绑时被取消，不再发起动态读取', async () => {
    const credentials = Promise.withResolvers()
    const rebindStarted = Promise.withResolvers()
    const renewed = Promise.withResolvers()
    let reads = 0, acquires = 0
    const manager = new QzoneManager({
        acquire() {
            if (++acquires === 1) return credentials.promise
            rebindStarted.resolve()
            return renewed.promise
        },
        createClient: () => ({
            listFeeds() { reads++; auth() },
            async updateSession() {},
            async close() {}
        }), logger, rebind
    })
    const first = new AbortController()
    const initial = manager.listFeedPage({ scope: 'friends', signal: first.signal })
    first.abort()
    credentials.resolve(grant)
    await assert.rejects(initial, { name: 'AbortError' })
    assert.equal(reads, 0)
    const second = new AbortController()
    const retry = manager.listFeedPage({ scope: 'friends', signal: second.signal })
    await rebindStarted.promise
    second.abort()
    renewed.resolve(grant)
    await assert.rejects(retry, { name: 'AbortError' })
    assert.equal(reads, 1)
    await manager.close()
})

test('发布、评论、回复登录失效只续绑不重发，结果不确定时同样不重发', async () => {
    for (const [serviceMethod, sdkMethod] of [['publish', 'publishPost'], ['comment', 'comment'], ['reply', 'reply']]) {
        for (const outcome of ['auth', 'unknown']) {
            let writes = 0
            let updates = 0
            const result = { status: 'unknown' }
            const manager = new QzoneManager({
                acquire: async () => grant,
                createClient: () => ({
                    [sdkMethod]() { writes++; if (outcome === 'auth') auth(); return result },
                    async updateSession() { updates++ },
                    async close() {}
                }), logger, rebind
            })
            const write = manager[serviceMethod]({})
            if (outcome === 'auth') await assert.rejects(write, e => e instanceof QzoneWriteAuthError && e.operation === serviceMethod && e.rebound)
            else assert.equal(await write, result)
            assert.equal(writes, 1)
            assert.equal(updates, outcome === 'auth' ? 1 : 0)
            await manager.close()
        }
    }
})

test('工具在等待 Cookie 时取消不会发布，后续新请求仍可使用同一客户端', async () => {
    const pending = Promise.withResolvers()
    const signals = []
    const manager = new QzoneManager({
        acquire: () => pending.promise,
        createClient: () => ({ async publishPost({ signal }) { signals.push(signal); return { outcome: 'verified' } } }),
        logger, rebind
    })
    const cancelled = new AbortController()
    const post = signal => publishPost({ logger }, manager, { content: 'hello' }, signal)
    const first = post(cancelled.signal)
    cancelled.abort()
    pending.resolve(grant)
    await assert.rejects(first, { name: 'AbortError' })
    assert.equal(signals.length, 0)
    const next = new AbortController()
    assert.equal((await post(next.signal)).outcome, 'verified')
    assert.deepEqual(signals, [next.signal])
})

test('获取 Cookie 期间卸载，随后到达的授权不会初始化客户端或发帖', async () => {
    const pending = Promise.withResolvers()
    let created = false
    const manager = new QzoneManager({ acquire: () => pending.promise, createClient() { created = true }, logger, rebind })
    const writing = manager.publish({ content: 'hello' })
    const closing = manager.close()
    pending.resolve(grant)
    await assert.rejects(writing, QzoneCancelledError)
    await closing
    assert.equal(created, false)
    await assert.rejects(manager.publish({ content: 'later' }), QzoneCancelledError)
})

test('续绑期间卸载，旧读操作不重放，不接收新发布，不再更新登录态', async () => {
    const entered = Promise.withResolvers()
    const pending = Promise.withResolvers()
    let acquires = 0, reads = 0, updates = 0, writes = 0, closes = 0
    const manager = new QzoneManager({
        acquire: async () => {
            if (++acquires === 1) return grant
            entered.resolve()
            return pending.promise
        },
        createClient: () => ({
            getSessionInfo() { return { accountId: grant.accountId } },
            listFeeds() { reads++; auth() },
            async updateSession() { updates++ },
            async publishPost() { writes++ },
            async close() { closes++ }
        }), logger, rebind
    })
    const reading = manager.listFeedPage({ scope: 'self' })
    await entered.promise
    const closing = manager.close()
    await assert.rejects(manager.publish({ content: 'late' }), QzoneCancelledError)
    pending.resolve(grant)
    await assert.rejects(reading, QzoneCancelledError)
    await closing
    assert.deepEqual([reads, updates, writes, closes], [1, 0, 0, 1])
})

test('连续续绑失败按最短间隔和指数退避限制，达到上限停用，成功清零计数', async () => {
    let now = 0
    const controller = new RebindController({ ...rebind, minIntervalSeconds: 1, nowSeconds: () => now })
    const fail = async () => { throw Error('fail') }
    await assert.rejects(controller.attempt(fail), /fail/)
    assert.throws(() => controller.attempt(fail), RebindRejectedError)
    now = 2
    await controller.attempt(async () => {})
    assert.equal(controller.stats().consecutiveFailures, 0)
    assert.equal(controller.stats().nextAllowedAtSeconds, 3)
    now = 3
    await assert.rejects(controller.attempt(fail), /fail/)
    now = 5
    await assert.rejects(controller.attempt(fail), /fail/)
    assert.equal(controller.stats().nextAllowedAtSeconds, 8)
    now = 8
    await assert.rejects(controller.attempt(fail), /fail/)
    assert.equal(controller.stats().disabled, true)
    now = 100
    assert.throws(() => controller.attempt(fail), /停用/)
})
