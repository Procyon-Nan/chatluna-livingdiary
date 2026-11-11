import {
    type CommentMutationResult,
    type CommentOptions,
    type FeedPage,
    type GetPostOptions,
    type ListFeedsOptions,
    type PostMutationResult,
    type PublishPostOptions,
    QzoneAuthError,
    QzoneCancelledError,
    type QzoneClient,
    type QzonePost,
    type ReplyOptions,
    type SessionInfo
} from 'qzone-sdk'
import type { CookieBot, QzoneCookieGrant } from './cookie-source.js'
import type { Logger } from 'cordis'
import {
    RebindController,
    type RebindOptions,
    RebindRejectedError,
    type RebindStats
} from './rebind.js'

export interface QzoneManagerStatus {
    readonly initialized: boolean
    readonly accountId: string | null
    readonly authenticated: boolean
    readonly sessionUpdatedAt: string | null
    readonly rebind: RebindStats
}

export type QzoneWriteOperation = 'publish' | 'comment' | 'reply'

/** 写操作登录态失效：已按策略尝试续绑，但绝不自动重放。 */
export class QzoneWriteAuthError extends Error {
    readonly operation: QzoneWriteOperation
    readonly rebound: boolean

    constructor(operation: QzoneWriteOperation, rebound: boolean) {
        const labels: Record<QzoneWriteOperation, string> = {
            publish: '发布动态',
            comment: '评论动态',
            reply: '回复评论'
        }
        super(
            rebound
                ? `${labels[operation]}时登录态失效，续绑已完成`
                : `${labels[operation]}时登录态失效，续绑不可用`
        )
        this.name = 'QzoneWriteAuthError'
        this.operation = operation
        this.rebound = rebound
    }
}

export interface QzoneManagerDeps {
    readonly currentBot: () => Pick<CookieBot, 'platform' | 'selfId'> | undefined
    /** 获取一份通过验收的 Cookie；失败视为一次续绑失败。 */
    readonly acquire: () => Promise<QzoneCookieGrant>
    readonly createClient: (session: Pick<QzoneCookieGrant, 'accountId' | 'cookies'>) => QzoneClient
    readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>
    readonly rebind: RebindOptions
}

/**
 * 单账号 QzoneClient 管理器：懒初始化、失效续绑与关闭语义。
 *
 * 读操作在续绑成功后自动重放一次（幂等）；写操作不重放——payload 级
 * 失效检测存在误报可能，自动重放可能导致重复发布。
 */
export class QzoneManager {
    readonly #rebind: RebindController
    readonly #deps: QzoneManagerDeps
    #client: QzoneClient | null = null
    #initInFlight?: Promise<QzoneClient>
    #closed = false

    constructor(deps: QzoneManagerDeps) {
        this.#deps = deps
        this.#rebind = new RebindController({
            ...deps.rebind,
            logger: deps.rebind.logger ?? deps.logger
        })
    }

    /** 读取动态页；登录态失效时续绑成功后重放一次读取。 */
    listFeedPage(query: ListFeedsOptions): Promise<FeedPage> {
        return this.#runRead('读取动态', (client) => client.listFeeds(query))
    }

    /** 读取动态详情；登录态失效时续绑成功后重放一次读取。 */
    getPost(request: GetPostOptions): Promise<QzonePost> {
        return this.#runRead('读取动态详情', (client) =>
            client.getPost(request)
        )
    }

    /** 发布图文动态；登录态失效时仅触发续绑，不自动重放。 */
    publish(request: PublishPostOptions): Promise<PostMutationResult> {
        return this.#runWrite('publish', '发布动态', request.signal, (client) =>
            client.publishPost(request)
        )
    }

    /** 评论动态；登录态失效时仅触发续绑，不自动重放。 */
    comment(request: CommentOptions): Promise<CommentMutationResult> {
        return this.#runWrite('comment', '评论动态', request.signal, (client) =>
            client.comment(request)
        )
    }

    /** 回复评论；登录态失效时仅触发续绑，不自动重放。 */
    reply(request: ReplyOptions): Promise<CommentMutationResult> {
        return this.#runWrite('reply', '回复评论', request.signal, (client) =>
            client.reply(request)
        )
    }

    status() {
        const selected = this.#deps.currentBot()
        const bot = selected ? { platform: selected.platform, selfId: selected.selfId } : null
        return { bot, client: this.#clientStatus() }
    }

    #clientStatus(): QzoneManagerStatus {
        const info: SessionInfo | null = this.#client?.getSessionInfo() ?? null
        return {
            initialized: this.#client !== null,
            accountId: info?.accountId ?? null,
            authenticated: info?.authenticated ?? false,
            sessionUpdatedAt: info?.updatedAt ?? null,
            rebind: this.#rebind.stats()
        }
    }

    async close(): Promise<void> {
        this.#closed = true
        await this.#initInFlight?.catch(() => {})
        await this.#rebind.settled()
        const client = this.#client
        this.#client = null
        await client?.close()
    }

    #assertOpen(): void {
        if (this.#closed) throw new QzoneCancelledError('QQ 空间客户端已随插件停止释放')
    }

    async #getClient(): Promise<QzoneClient> {
        this.#assertOpen()
        if (this.#client) return this.#client
        if (!this.#initInFlight) {
            this.#initInFlight = this.#deps.acquire().then(({ cookies, accountId }) => {
                this.#assertOpen()
                return this.#client = this.#deps.createClient({ cookies, accountId })
            }).finally(() => { this.#initInFlight = undefined })
        }
        return this.#initInFlight
    }

    async #runRead<T>(
        phase: string,
        operation: (client: QzoneClient) => Promise<T>
    ): Promise<T> {
        const client = await this.#getClient()
        this.#assertOpen()
        try {
            return await operation(client)
        } catch (error) {
            if (!(error instanceof QzoneAuthError)) {
                throw error
            }
            const rebound = await this.#tryRebind(client, phase)
            if (!rebound) {
                throw error
            }
            this.#assertOpen()
            return operation(client)
        }
    }

    async #runWrite<T>(
        kind: QzoneWriteOperation,
        phase: string,
        signal: AbortSignal | undefined,
        operation: (client: QzoneClient) => Promise<T>
    ): Promise<T> {
        const client = await this.#getClient()
        this.#assertOpen()
        signal?.throwIfAborted()
        try {
            return await operation(client)
        } catch (error) {
            if (error instanceof QzoneAuthError) {
                const rebound = await this.#tryRebind(client, phase)
                throw new QzoneWriteAuthError(kind, rebound)
            }
            throw error
        }
    }

    /** 执行一次续绑（单飞、限流）；返回续绑是否成功。 */
    async #tryRebind(client: QzoneClient, phase: string): Promise<boolean> {
        this.#assertOpen()
        try {
            await this.#rebind.attempt(async () => {
                this.#assertOpen()
                const { cookies, accountId } = await this.#deps.acquire()
                this.#assertOpen()
                await client.updateSession({ cookies, accountId })
            })
            return true
        } catch (error) {
            this.#assertOpen()
            if (error instanceof RebindRejectedError) {
                this.#deps.logger.warn(`续绑被拒绝（${phase}）：${error.message}`)
            } else {
                this.#deps.logger.warn(`续绑失败（${phase}），连续失败 ${this.#rebind.stats().consecutiveFailures} 次`)
            }
            return false
        }
    }
}
