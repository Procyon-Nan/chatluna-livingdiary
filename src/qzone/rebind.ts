import type { Logger } from 'cordis'

/** 续绑请求被限流或已停用时抛出。 */
export class RebindRejectedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RebindRejectedError'
    }
}

export interface RebindOptions {
    /** 两次续绑尝试之间的最小间隔（秒）。 */
    readonly minIntervalSeconds: number
    /** 失败退避基数（秒），随连续失败次数指数增长。 */
    readonly backoffSeconds: number
    /** 退避封顶（秒）。 */
    readonly maxBackoffSeconds: number
    /** 连续失败达到该次数后停用自动续绑。 */
    readonly maxConsecutiveFailures: number
    /** 可注入的 Unix 秒时钟，默认取当前时间。 */
    readonly nowSeconds?: () => number
    /** 状态转换日志（停用/恢复）；失败明细由调用方记录。 */
    readonly logger?: Pick<Logger, 'info' | 'error'>
}

export interface RebindStats {
    readonly inFlight: boolean
    readonly disabled: boolean
    readonly consecutiveFailures: number
    readonly lastAttemptAtSeconds: number | null
    readonly lastSuccessAtSeconds: number | null
    readonly nextAllowedAtSeconds: number | null
}

/**
 * 单账号续绑状态机：并发单飞、最小间隔、指数退避与连续失败停用。
 *
 * 不持有定时器，时间门控在调用时按注入时钟判定；插件重载即整体重置。
 */
export class RebindController {
    readonly #options: RebindOptions
    readonly #nowSeconds: () => number
    #inFlight: Promise<void> | null = null
    #lastAttemptAtSeconds: number | null = null
    #lastSuccessAtSeconds: number | null = null
    #consecutiveFailures = 0
    #disabled = false

    constructor(options: RebindOptions) {
        this.#options = options
        this.#nowSeconds = options.nowSeconds ?? (() => Date.now() / 1000)
    }

    /**
     * 请求一次续绑。并发调用共享同一个在途结果（单飞）；成功后清零
     * 失败计数，失败后累计并按退避延长下一次允许时间。
     */
    attempt(action: () => Promise<void>): Promise<void> {
        if (this.#disabled) {
            throw new RebindRejectedError(
                '自动续绑已因连续失败停用，请处理登录态后重载插件'
            )
        }
        if (this.#inFlight) {
            return this.#inFlight
        }
        const nowSeconds = this.#nowSeconds()
        if (this.#lastAttemptAtSeconds !== null) {
            const wait = Math.max(
                this.#options.minIntervalSeconds,
                this.#backoffDelay()
            )
            const elapsed = nowSeconds - this.#lastAttemptAtSeconds
            if (elapsed < wait) {
                throw new RebindRejectedError(
                    `续绑触发过于频繁，请在 ${Math.ceil(wait - elapsed)} 秒后重试`
                )
            }
        }
        this.#lastAttemptAtSeconds = nowSeconds
        const task = Promise.resolve().then(async () => {
            try {
                await action()
                if (this.#consecutiveFailures > 0) {
                    this.#options.logger?.info('续绑：成功，自动续绑已恢复')
                }
                this.#consecutiveFailures = 0
                this.#lastSuccessAtSeconds = this.#nowSeconds()
            } catch (error) {
                this.#consecutiveFailures += 1
                if (
                    this.#consecutiveFailures >=
                    this.#options.maxConsecutiveFailures
                ) {
                    this.#disabled = true
                    this.#options.logger?.error(
                        `续绑：连续失败 ${this.#consecutiveFailures} 次，` +
                            '自动续绑已停用，请处理登录态后重载插件'
                    )
                }
                throw error
            } finally {
                this.#inFlight = null
            }
        })
        this.#inFlight = task
        return task
    }

    stats(): RebindStats {
        let nextAllowedAtSeconds: number | null = null
        if (this.#lastAttemptAtSeconds !== null && !this.#disabled) {
            const wait = Math.max(
                this.#options.minIntervalSeconds,
                this.#backoffDelay()
            )
            nextAllowedAtSeconds = this.#lastAttemptAtSeconds + wait
        }
        return {
            inFlight: this.#inFlight !== null,
            disabled: this.#disabled,
            consecutiveFailures: this.#consecutiveFailures,
            lastAttemptAtSeconds: this.#lastAttemptAtSeconds,
            lastSuccessAtSeconds: this.#lastSuccessAtSeconds,
            nextAllowedAtSeconds
        }
    }

    async settled(): Promise<void> {
        await this.#inFlight?.catch(() => {})
    }

    #backoffDelay(): number {
        if (this.#consecutiveFailures === 0) {
            return 0
        }
        const factor = 2 ** (this.#consecutiveFailures - 1)
        return Math.min(
            this.#options.backoffSeconds * factor,
            this.#options.maxBackoffSeconds
        )
    }
}
