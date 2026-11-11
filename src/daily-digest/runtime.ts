import type { Logger } from 'cordis'
import type { DailyDigestReport, DailyDigestTrigger, RuntimeReports } from './report.js'

export interface DigestTime {
    hour: number
    minute: number
}

export function nextDigestDelay(time: DigestTime, from: Date): number {
    const at = (day: number) => new Date(from.getFullYear(), from.getMonth(), day, time.hour, time.minute).getTime()
    const today = at(from.getDate())
    const next = today > from.getTime() ? today : at(from.getDate() + 1)
    return next - from.getTime()
}

type RunDigest = (trigger: DailyDigestTrigger, signal: AbortSignal, startedAt: Date) => Promise<DailyDigestReport>

export class DailyDigestRuntime {
    readonly #controller = new AbortController()
    #inFlight?: Promise<DailyDigestReport>
    #timer?: ReturnType<typeof setTimeout>

    constructor(
        private readonly execute: RunDigest,
        private readonly reports: RuntimeReports,
        private readonly logger: Pick<Logger, 'info' | 'error'>
    ) {}

    get stopped(): boolean {
        return this.#controller.signal.aborted
    }

    /** 已有任务时不排队，也不重复发起模型或空间请求。 */
    run(trigger: DailyDigestTrigger): Promise<DailyDigestReport> | undefined {
        const { signal } = this.#controller
        signal.throwIfAborted()
        if (this.#inFlight) return
        this.#inFlight = this.execute(trigger, signal, new Date())
            .then(report => {
                if (!signal.aborted) this.reports.digest = report
                return report
            })
            .finally(() => { this.#inFlight = undefined })
        return this.#inFlight
    }

    schedule(time: DigestTime): void {
        const fire = () => {
            const task = this.run('scheduled')
            if (task) {
                task.catch(() => {
                    if (!this.stopped) this.logger.error('每日日记：定时任务执行失败')
                })
            } else {
                this.logger.info('每日日记：已有任务执行中，跳过本次定时触发')
            }
            this.#timer = setTimeout(fire, nextDigestDelay(time, new Date()))
        }
        this.#timer = setTimeout(fire, nextDigestDelay(time, new Date()))
    }

    async stop(): Promise<void> {
        clearTimeout(this.#timer)
        this.#controller.abort()
        await this.#inFlight?.catch(() => {})
    }
}
