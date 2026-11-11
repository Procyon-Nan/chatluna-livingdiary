import { QzoneNotFoundError, QzoneValidationError } from 'qzone-sdk'
import { ModelError } from '@chatluna/ai'
import type {
    CommentMutationResult,
    CommentOptions,
    FeedPage,
    GetPostOptions,
    QzonePost,
    ReplyOptions
} from 'qzone-sdk'
import { isCommentInBotThread } from './state.js'
import {
    advanceFeedWatermark,
    baselineMonitoredPost,
    createFeedWatermark,
    createFriendPostTrigger,
    createInteractionRuntimeState,
    createMonitoredPost,
    discoverCommentTriggers,
    enqueueTrigger,
    findCommentByKey,
    type FeedWatermark,
    type InteractionRuntimeState,
    isInteractionActorAllowed,
    isPostAfterWatermark,
    type PendingTrigger,
    postKey,
    removeMonitoredPost,
    sortPendingTriggers,
    trimMonitoredPosts
} from './state.js'
import {
    emptyRoundStats,
    initialInteractionReport,
    type InteractionErrorKind,
    type InteractionPhase,
    type InteractionReport,
    type InteractionRoundStats
} from './report.js'
import { QzoneWriteAuthError } from '../qzone/manager.js'
import type { Logger } from 'cordis'
import type { QzoneComment } from 'qzone-sdk'

const FEED_PAGE_LIMIT = 6
const FEED_PAGE_SIZE = 20

export interface AutoInteractionDeps {
    readonly now: () => Date
    readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
    readonly isBotOnline: () => boolean
    readonly listFeedPage: (request: {
        readonly scope: 'self' | 'friends'
        readonly limit: number
        readonly cursor?: string
        readonly signal?: AbortSignal
    }) => Promise<FeedPage>
    readonly getPost: (request: GetPostOptions) => Promise<QzonePost>
    readonly comment: (
        request: CommentOptions
    ) => Promise<CommentMutationResult>
    readonly reply: (request: ReplyOptions) => Promise<CommentMutationResult>
    readonly getAccountId: () => string | null
    readonly persona: () => Promise<{ persona: string; assistantLabel: string }>
    readonly decide: (input: {
        detail: QzonePost
        trigger: PendingTrigger
        activeComment: QzoneComment | null
        persona: string
        assistantLabel: string
    }, signal: AbortSignal) => Promise<{ action: 'skip' } | { action: 'publish'; content: string }>

}

export interface AutoInteractionOptions {
    readonly enableFriendPostComment: boolean
    readonly whitelistEnabled: boolean
    readonly allowIds: ReadonlySet<string>
    readonly monitorLimit: number
    readonly maxWritesPerRound: number
}

const postTimestamp = (post: QzonePost, fallback: number): number => {
    if (post.createdAt === null) return fallback
    const parsed = Date.parse(post.createdAt)
    return Number.isFinite(parsed) ? parsed : fallback
}

const mutableRoundStats = (): {
    -readonly [Key in keyof InteractionRoundStats]: InteractionRoundStats[Key]
} => ({ ...emptyRoundStats() })

export class AutoInteractionRuntime {
    private currentReport: InteractionReport

    get report(): InteractionReport {
        return this.currentReport
    }

    state: InteractionRuntimeState = createInteractionRuntimeState()
    readonly #deps: AutoInteractionDeps
    readonly #options: AutoInteractionOptions
    readonly #controller = new AbortController()
    #selfWatermark: FeedWatermark | null = null
    // 去重仅覆盖本次好友 Feed 翻页，完成后由水位接管。
    readonly #friendScanKeys = new Set<string>()
    #inFlight?: Promise<void>
    #friendFeedCursor: string | undefined
    #friendFeedCandidateWatermark: FeedWatermark | null = null
    #botId: string | null = null
    #roundStartedAt: string | null = null
    #lastRoundAt: string | null = null
    #lastRound: InteractionRoundStats | null = null
    #lastError: InteractionErrorKind | null = null

    constructor(deps: AutoInteractionDeps, options: AutoInteractionOptions) {
        this.#deps = deps
        this.#options = options
        this.currentReport = initialInteractionReport('waiting-bot', '等待建立启动基线', options.monitorLimit, options.maxWritesPerRound)
    }

    get stopped(): boolean {
        return this.#controller.signal.aborted
    }

    async stop(): Promise<void> {
        this.#controller.abort()
        await this.#inFlight
    }

    runRound(): Promise<void> {
        if (this.stopped) return Promise.resolve()
        if (!this.#inFlight) {
            this.#inFlight = Promise.resolve().then(() => {
                if (!this.stopped) return this.#poll()
            }).finally(() => { this.#inFlight = undefined })
        }
        return this.#inFlight
    }

    async #poll(): Promise<void> {
        if (this.state.baseline !== 'ready' && !this.#deps.isBotOnline()) {
            this.#lastError = null
            this.#setReport('waiting-bot', '所选机器人上线后自动建立基线')
            return
        }
        if (this.state.baseline !== 'ready') {
            await this.establishBaseline()
            return
        }
        const stats = mutableRoundStats()
        this.#roundStartedAt = this.#deps.now().toISOString()
        this.#lastError = null
        this.#setReport('running', '正在轮询', stats)
        try {
            await this.#discoverMonitoredComments(stats)
            if (this.stopped) return
            try { await this.#discoverSelfPosts(stats) }
            catch { if (!this.stopped) this.#recordError('round-read', stats) }
            if (this.stopped) return
            try { await this.#discoverFriendPosts(stats) }
            catch { if (!this.stopped) this.#recordError('round-read', stats) }
            if (this.stopped) return
            trimMonitoredPosts(this.state, this.#options.monitorLimit)
            await this.#processPending(stats)
            if (this.stopped) return
            this.#lastRoundAt = this.#deps.now().toISOString()
            this.#lastRound = { ...stats }
            this.#setReport('ready', '等待下一轮')
            const idleRound =
                stats.discovered === 0 &&
                stats.writeAttempts === 0 &&
                stats.incompleteSnapshots === 0 &&
                stats.errors === 0
            const roundSummary =
                '自动互动轮次完成：' +
                `发现 ${stats.discovered}，写入 ${stats.writeAttempts}，` +
                `不完整快照 ${stats.incompleteSnapshots}，错误 ${stats.errors}`
            if (idleRound) {
                this.#deps.logger.debug(roundSummary)
            } else {
                this.#deps.logger.info(roundSummary)
            }
            if (stats.incompleteSnapshots > 0) {
                this.#deps.logger.warn(
                    '自动互动：本轮存在评论快照不完整，' +
                        '相关触发已保留等待后续轮询'
                )
            }
        } catch {
            if (this.stopped) return
            this.#recordError('round-read', stats)
            this.#lastRoundAt = this.#deps.now().toISOString()
            this.#lastRound = { ...stats }
            this.#setReport('failed', '轮询失败')
            this.#deps.logger.error('自动互动轮次失败：读取或编排阶段异常')
        }
    }

    async establishBaseline(): Promise<void> {
        if (this.stopped) return
        this.#setReport('baselining', '正在读取当前动态与评论基线')
        const next = createInteractionRuntimeState()
        let selfWatermark: FeedWatermark | null = null
        try {
            const now = this.#deps.now().getTime()
            if (this.#options.monitorLimit > 0) {
                const selfPosts = await this.#readLatestSelfPosts(
                    this.#options.monitorLimit
                )
                selfWatermark = createFeedWatermark(selfPosts, now)
                for (const post of selfPosts) {
                    const detail = await this.#readListedPost(post)
                    if (!detail) continue
                    const monitored = createMonitoredPost(
                        detail,
                        'self',
                        postTimestamp(detail, now),
                        false
                    )
                    baselineMonitoredPost(monitored, detail, now)
                    next.monitoredPosts.set(monitored.key, monitored)
                }
                trimMonitoredPosts(next, this.#options.monitorLimit)
            }
            if (this.#options.enableFriendPostComment) {
                const friendBaselineAt = this.#deps.now().getTime()
                const page = await this.#deps.listFeedPage({
                    scope: 'friends',
                    limit: FEED_PAGE_SIZE,
                    signal: this.#controller.signal
                })
                next.friendFeedWatermark = createFeedWatermark(
                    page.items,
                    friendBaselineAt
                )
            }
            const botId = this.#deps.getAccountId()
            if (!botId) {
                throw new Error('QQ 空间 Session 未提供当前账号 ID')
            }
            next.baseline = 'ready'
            next.baselineCompletedAt = this.#deps.now().getTime()
            for (const monitored of next.monitoredPosts.values()) {
                monitored.ignoreCommentsThrough = next.baselineCompletedAt
                monitored.baselineObservationPending = true
            }
            if (
                next.friendFeedWatermark !== null &&
                next.friendFeedWatermark.timestamp < next.baselineCompletedAt
            ) {
                next.friendFeedWatermark = {
                    timestamp: next.baselineCompletedAt,
                    keysAtTimestamp: new Set()
                }
            }
            if (this.stopped) return
            this.state = next
            this.#botId = botId
            this.#selfWatermark = selfWatermark
            this.#friendFeedCursor = undefined
            this.#friendFeedCandidateWatermark = null
            this.#lastError = null
            this.#setReport('ready', '启动基线已建立')
            this.#deps.logger.info('自动互动：启动基线已建立')
        } catch {
            if (this.stopped) return
            this.#lastError = 'baseline'
            this.#setReport('failed', '启动基线建立失败，将于下轮重新读取')
            this.#deps.logger.error('自动互动：启动基线建立失败')
        }
    }

    async #readLatestSelfPosts(limit: number): Promise<readonly QzonePost[]> {
        const posts: QzonePost[] = []
        let cursor: string | undefined
        for (let pageIndex = 0; pageIndex < FEED_PAGE_LIMIT && posts.length < limit; pageIndex++) {
            const page = await this.#deps.listFeedPage({
                scope: 'self',
                limit: Math.min(FEED_PAGE_SIZE, limit - posts.length),
                ...(cursor ? { cursor } : {}),
                signal: this.#controller.signal
            })
            for (const post of page.items) {
                if (!posts.some((item) => postKey(item) === postKey(post))) {
                    posts.push(post)
                }
            }
            if (!page.nextCursor) break
            cursor = page.nextCursor
        }
        return posts.slice(0, limit)
    }

    /** 列表与详情之间动态可被删除；其他读取错误由当前轮次处理。 */
    async #readListedPost(post: QzonePost): Promise<QzonePost | null> {
        try {
            return await this.#deps.getPost({ post, signal: this.#controller.signal })
        } catch (error) {
            if (error instanceof QzoneNotFoundError) return null
            throw error
        }
    }

    async #discoverMonitoredComments(
        stats: ReturnType<typeof mutableRoundStats>
    ): Promise<void> {
        if (this.#options.monitorLimit === 0 || !this.#botId) return
        for (const monitored of [...this.state.monitoredPosts.values()]) {
            try {
                const detail = await this.#deps.getPost({
                    post: monitored.post,
                    signal: this.#controller.signal
                })
                if (!detail.commentsComplete) {
                    stats.incompleteSnapshots += 1
                    continue
                }
                for (const trigger of discoverCommentTriggers(
                    monitored,
                    detail,
                    {
                        botId: this.#botId,
                        whitelistEnabled: this.#options.whitelistEnabled,
                        allowIds: this.#options.allowIds,
                        detectedAt: this.#deps.now().getTime()
                    }
                )) {
                    if (enqueueTrigger(this.state, trigger)) {
                        stats.discovered += 1
                    }
                }
            } catch (error) {
                if (this.stopped) return
                if (error instanceof QzoneNotFoundError) {
                    removeMonitoredPost(this.state, monitored.key)
                    this.#deps.logger.debug(
                        '自动互动：受监控动态已不存在，已停止监控'
                    )
                    continue
                }
                this.#recordError('monitored-read', stats)
                this.#deps.logger.warn('自动互动：读取监控动态失败')
            }
        }
    }

    async #discoverSelfPosts(
        stats: ReturnType<typeof mutableRoundStats>
    ): Promise<void> {
        if (this.#options.monitorLimit === 0 || !this.#botId) return
        const posts = await this.#readLatestSelfPosts(
            this.#options.monitorLimit
        )
        const baselineAt =
            this.state.baselineCompletedAt ?? Number.MAX_SAFE_INTEGER
        for (const post of posts) {
            const key = postKey(post)
            if (this.state.monitoredPosts.has(key) || (this.#selfWatermark && !isPostAfterWatermark(post, this.#selfWatermark))) continue
            if (postTimestamp(post, 0) <= baselineAt) continue
            const detail = await this.#readListedPost(post)
            if (!detail) continue
            const monitored = createMonitoredPost(
                post,
                'self',
                postTimestamp(post, this.#deps.now().getTime()),
                true
            )
            this.state.monitoredPosts.set(key, monitored)
            if (!detail.commentsComplete) {
                stats.incompleteSnapshots += 1
                continue
            }
            for (const trigger of discoverCommentTriggers(monitored, detail, {
                botId: this.#botId,
                whitelistEnabled: this.#options.whitelistEnabled,
                allowIds: this.#options.allowIds,
                detectedAt: this.#deps.now().getTime()
            })) {
                if (enqueueTrigger(this.state, trigger)) stats.discovered += 1
            }
        }
        if (this.#selfWatermark) this.#selfWatermark = advanceFeedWatermark(this.#selfWatermark, posts)
    }

    async #discoverFriendPosts(
        stats: ReturnType<typeof mutableRoundStats>
    ): Promise<void> {
        if (!this.#options.enableFriendPostComment) return
        const watermark = this.state.friendFeedWatermark
        if (!watermark) throw new Error('好友动态 Feed 水位尚未建立')
        let cursor = this.#friendFeedCursor
        const visited = new Set<string>()
        let candidate = this.#friendFeedCandidateWatermark ?? watermark
        for (let round = 0; round < FEED_PAGE_LIMIT; round++) {
            if (cursor) visited.add(cursor)
            let page: FeedPage
            try {
                page = await this.#deps.listFeedPage({ scope: 'friends', limit: FEED_PAGE_SIZE, cursor, signal: this.#controller.signal })
            } catch (error) {
                // SDK 的分页游标会被淘汰。重扫仍沿用已处理的动态键，直至到达上次水位。
                if (cursor && error instanceof QzoneValidationError) this.#friendFeedCursor = undefined
                throw error
            }
            candidate = advanceFeedWatermark(candidate, page.items)
            for (const post of page.items) {
                if (!isPostAfterWatermark(post, watermark)) continue
                if (this.#botId !== null && post.author.id === this.#botId) {
                    continue
                }
                if (
                    !isInteractionActorAllowed(
                        post.author.id,
                        this.#options.whitelistEnabled,
                        this.#options.allowIds
                    )
                ) {
                    continue
                }
                const key = postKey(post)
                if (this.#friendScanKeys.has(key)) continue
                this.#friendScanKeys.add(key)
                if (
                    enqueueTrigger(
                        this.state,
                        createFriendPostTrigger(
                            post,
                            this.#deps.now().getTime()
                        )
                    )
                ) {
                    stats.discovered += 1
                }
            }
            const reachedOld = page.items.some((post) => {
                if (post.createdAt === null) return false
                const at = Date.parse(post.createdAt)
                return Number.isFinite(at) && at < watermark.timestamp
            })
            if (reachedOld || !page.nextCursor || page.items.length === 0) {
                this.state.friendFeedWatermark = candidate
                this.#friendScanKeys.clear()
                this.#friendFeedCursor = undefined
                this.#friendFeedCandidateWatermark = null
                return
            }
            if (visited.has(page.nextCursor)) {
                this.#friendFeedCursor = undefined
                this.#friendFeedCandidateWatermark = candidate
                this.#recordError('round-read', stats)
                this.#deps.logger.warn('自动互动：好友动态分页重复，将从首页重新读取')
                return
            }
            cursor = page.nextCursor
            this.#friendFeedCursor = cursor
            this.#friendFeedCandidateWatermark = candidate
            if (round === FEED_PAGE_LIMIT - 1) {
                stats.feedPageLimitHits += 1
                this.#deps.logger.warn(
                    '自动互动：好友 Feed 扫描达到 6 页保护上限'
                )
                return
            }
        }
    }

    async #processPending(
        stats: ReturnType<typeof mutableRoundStats>
    ): Promise<void> {
        const blockedPosts = new Set<string>()
        let persona: { persona: string; assistantLabel: string } | undefined
        for (const trigger of sortPendingTriggers(
            this.state.pendingTriggers.values()
        )) {
            if (this.stopped) return
            if (stats.writeAttempts >= this.#options.maxWritesPerRound) return
            if (!this.state.pendingTriggers.has(trigger.key)) continue
            if (blockedPosts.has(postKey(trigger.post))) continue
            let detail: QzonePost
            try {
                detail = await this.#deps.getPost({
                    post: trigger.post,
                    signal: this.#controller.signal
                })
            } catch (error) {
                if (this.stopped) return
                if (error instanceof QzoneNotFoundError) {
                    removeMonitoredPost(this.state, postKey(trigger.post))
                    continue
                }
                this.#recordError('detail-refresh', stats)
                continue
            }
            if (!detail.commentsComplete) {
                stats.incompleteSnapshots += 1
                blockedPosts.add(postKey(trigger.post))
                continue
            }
            const activeComment =
                trigger.commentKey === null
                    ? null
                    : findCommentByKey(detail, trigger.commentKey)
            if (trigger.commentKey !== null && activeComment === null) {
                this.state.pendingTriggers.delete(trigger.key)
                continue
            }
            const actorId = activeComment?.author.id ?? detail.author.id
            if (
                actorId === this.#botId ||
                !isInteractionActorAllowed(
                    actorId,
                    this.#options.whitelistEnabled,
                    this.#options.allowIds
                )
            ) {
                this.state.pendingTriggers.delete(trigger.key)
                continue
            }
            if (trigger.kind === 'friend-thread-reply') {
                const monitored = this.state.monitoredPosts.get(
                    postKey(trigger.post)
                )
                if (
                    !activeComment ||
                    !monitored?.botThreadRoot ||
                    !isCommentInBotThread(
                        activeComment,
                        monitored.botThreadRoot
                    )
                ) {
                    this.state.pendingTriggers.delete(trigger.key)
                    continue
                }
            }
            if (!persona) {
                try { persona = await this.#deps.persona() }
                catch { this.#recordError('persona', stats); return }
            }
            if (this.stopped) return
            let decision
            try {
                decision = await this.#deps.decide({ ...persona, detail, trigger, activeComment }, this.#controller.signal)
            } catch (error) {
                if (this.stopped) return
                if (error instanceof ModelError && (error.code === 'NO_MODEL' || error.code === 'NO_PROVIDER')) {
                    this.#recordError('model-unavailable', stats)
                    this.#deps.logger.warn('自动互动：互动模型不可用，本轮剩余任务保留至下次轮询')
                    return
                }
                this.#recordError('model-decision', stats)
                this.#deps.logger.warn(`自动互动：模型决策失败（动态：${trigger.post.id}）`)
                continue
            }
            if (this.stopped) return
            if (decision.action === 'skip') {
                stats.modelSkipped += 1
                this.state.pendingTriggers.delete(trigger.key)
                continue
            }
            stats.writeAttempts += 1
            try {
                const result =
                    trigger.kind === 'friend-post'
                        ? await this.#deps.comment({
                              post: detail,
                              content: decision.content.trim(),
                              signal: this.#controller.signal
                          })
                        : await this.#deps.reply({
                              post: detail,
                              comment: activeComment!,
                              content: decision.content.trim(),
                              signal: this.#controller.signal
                          })
                if (this.stopped) return
                this.state.pendingTriggers.delete(trigger.key)
                if (result.outcome === 'verified' || result.outcome === 'already-applied') stats.verified += 1
                if (result.outcome === 'accepted') stats.accepted += 1
                if (result.outcome === 'unknown') stats.unknown += 1
                if (trigger.kind === 'friend-post') {
                    await this.#startFriendThread(detail, result, stats)
                } else {
                    await this.#refreshSeenAfterWrite(trigger.post, stats)
                }
            } catch (error) {
                if (this.stopped) return
                this.state.pendingTriggers.delete(trigger.key)
                this.#recordError(
                    error instanceof QzoneWriteAuthError
                        ? 'write-auth'
                        : 'write',
                    stats
                )
            }
        }
    }

    async #startFriendThread(
        detail: QzonePost,
        result: CommentMutationResult,
        stats: ReturnType<typeof mutableRoundStats>
    ): Promise<void> {
        if (this.#options.monitorLimit === 0 || !this.#botId) return
        const reference = result.comment ?? result.reference
        if (!reference) return
        if ('kind' in reference && reference.kind !== 'comment') return
        const botThreadRoot =
            'author' in reference
                ? { id: reference.id, authorId: reference.author.id }
                : { id: reference.id, authorId: reference.authorId }
        if (botThreadRoot.authorId !== this.#botId) return
        const monitored = createMonitoredPost(
            detail,
            'friend',
            this.#deps.now().getTime(),
            false,
            botThreadRoot
        )
        baselineMonitoredPost(monitored, detail, this.#deps.now().getTime())
        this.state.monitoredPosts.set(monitored.key, monitored)
        trimMonitoredPosts(this.state, this.#options.monitorLimit)
        await this.#refreshSeenAfterWrite(detail, stats)
    }

    async #refreshSeenAfterWrite(
        post: QzonePost | PendingTrigger['post'],
        stats: ReturnType<typeof mutableRoundStats>
    ) {
        const monitored = this.state.monitoredPosts.get(postKey(post))
        const botId = this.#botId
        if (!monitored || !botId) return
        try {
            const refreshed = await this.#deps.getPost({
                post,
                signal: this.#controller.signal
            })
            if (this.stopped) return
            if (refreshed.commentsComplete) {
                for (const trigger of discoverCommentTriggers(
                    monitored,
                    refreshed,
                    {
                        botId,
                        whitelistEnabled: this.#options.whitelistEnabled,
                        allowIds: this.#options.allowIds,
                        detectedAt: this.#deps.now().getTime()
                    }
                )) {
                    if (enqueueTrigger(this.state, trigger)) {
                        stats.discovered += 1
                    }
                }
            }
        } catch {
            // 写入终态已经确定；刷新失败不得改变终态或触发重发。
            if (!this.stopped) {
                this.#recordError('detail-refresh', stats)
            }
        }
    }

    #recordError(
        kind: InteractionErrorKind,
        stats: ReturnType<typeof mutableRoundStats>
    ): void {
        stats.errors += 1
        this.#lastError = kind
    }

    #setReport(
        phase: InteractionPhase,
        detail: string,
        currentRound?: InteractionRoundStats
    ): void {
        this.currentReport = {
            phase,
            detail,
            baselineCompletedAt:
                this.state.baselineCompletedAt === null
                    ? null
                    : new Date(this.state.baselineCompletedAt).toISOString(),
            roundStartedAt: this.#roundStartedAt,
            lastRoundAt: this.#lastRoundAt,
            monitoredPosts: this.state.monitoredPosts.size,
            monitorLimit: this.#options.monitorLimit,
            pendingTriggers: this.state.pendingTriggers.size,
            maxWritesPerRound: this.#options.maxWritesPerRound,
            round: currentRound ?? this.#lastRound,
            lastError: this.#lastError
        }
    }
}
