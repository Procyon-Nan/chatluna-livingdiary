import type { Context } from 'cordis'
import { QzoneClient } from 'qzone-sdk'
import type { Config } from '../config.js'
import { acquireQzoneCookies, canonicalQQ, NoBotAvailableError, selectCookieBot } from './cookie-source.js'
import { QzoneManager } from './manager.js'

type QzoneConfig = Pick<Config, 'platform' | 'selfId' | 'rebindMinIntervalSeconds' | 'rebindBackoffSeconds' | 'rebindMaxConsecutiveFailures'>

export function createQzoneService(ctx: Context, config: QzoneConfig) {
    let boundSelfId = config.selfId
    const currentBot = () => selectCookieBot(ctx.satori.bots, config.platform, boundSelfId)
    return new QzoneManager({
        currentBot,
        acquire: () => {
            const bot = currentBot()
            if (!bot) throw new NoBotAvailableError('没有可用的 OneBot/Milky 机器人（未上线或 platform/selfId 不匹配）')
            return acquireQzoneCookies(bot)
        },
        createClient: session => {
            const client = new QzoneClient({
                session,
                logger(event) {
                    const parts = ['qzone-sdk', event.phase, event.endpoint]
                    if (event.statusCode !== undefined) parts.push(`HTTP ${event.statusCode}`)
                    if (event.errorCode) parts.push(`code=${event.errorCode}`)
                    if (event.retryCount !== undefined) parts.push(`retry=${event.retryCount}`)
                    if (event.durationMs !== undefined) parts.push(`${event.durationMs}ms`)
                    ctx.logger[event.level](parts.filter(Boolean).join(' '))
                }
            })
            boundSelfId = canonicalQQ(session.accountId)
            return client
        },
        logger: ctx.logger,
        rebind: {
            minIntervalSeconds: config.rebindMinIntervalSeconds,
            backoffSeconds: config.rebindBackoffSeconds,
            maxBackoffSeconds: 300,
            maxConsecutiveFailures: config.rebindMaxConsecutiveFailures
        }
    })
}

export type QzoneService = ReturnType<typeof createQzoneService>
export type LivingDiaryStatus = ReturnType<QzoneService['status']>
