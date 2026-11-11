import type { Context } from 'cordis'
import type { Config } from '../config.js'
import { renderPersona } from '../persona.js'
import { canonicalQQ } from '../qzone/cookie-source.js'
import type { QzoneService } from '../qzone/service.js'
import type { RuntimeReports } from '../status.js'
import { decideInteraction } from './agent.js'
import { initialInteractionReport } from './report.js'
import { AutoInteractionRuntime } from './runtime.js'
import { normalizeInteractionAllowList } from './state.js'

export function registerAutoInteraction(ctx: Context, config: Config, qzone: QzoneService, reports: RuntimeReports) {
    const monitorLimit = config.interactionMonitorPostLimit
    const maxWrites = config.interactionMaxWritesPerRound
    const presetId = config.personaPresetId.trim()
    const model = config.subModel.trim()
    const enabled = config.enableFriendPostComment || monitorLimit > 0
    const allow = normalizeInteractionAllowList(config.interactionAllowUserIds)
    if (allow.invalidCount) ctx.logger.warn(`自动互动：忽略了 ${allow.invalidCount} 个无效 QQ 号`)
    const missing: string[] = []
    if (!presetId) missing.push('人设预设')
    if (!model) missing.push('互动模型')
    if (config.enableInteractionWhitelist && !allow.ids.size) missing.push('互动白名单')
    if (!enabled || missing.length) {
        const detail = enabled ? `请配置${missing.join('、')}` : '评论好友动态已关闭，监控数为零'
        const report = initialInteractionReport(enabled ? 'waiting-config' : 'disabled', detail, monitorLimit, maxWrites)
        ctx.effect(() => {
            reports.interaction = () => report
            return () => { reports.interaction = null }
        })
        return
    }

    const runtime = new AutoInteractionRuntime({
        now: () => new Date(), logger: ctx.logger,
        isBotOnline: () => qzone.status().bot !== null,
        getAccountId() {
            const id = qzone.status().client.accountId
            return id && canonicalQQ(id)
        },
        listFeedPage: query => qzone.listFeedPage(query),
        getPost: query => qzone.getPost(query),
        comment: query => qzone.comment(query),
        reply: query => qzone.reply(query),
        async persona() {
            const preset = ctx.presets.get(presetId)
            if (!preset || preset.status === 'error') throw new Error('空间预设不可用')
            const persona = await renderPersona(ctx, preset, new Date())
            if (!persona) throw new Error('空间预设缺少人设')
            return { assistantLabel: preset.name, persona }
        },
        decide: (input, signal) => decideInteraction(ctx, { ...input, model, debug: config.debug }, signal)
    }, {
        enableFriendPostComment: config.enableFriendPostComment,
        whitelistEnabled: config.enableInteractionWhitelist, allowIds: allow.ids,
        monitorLimit, maxWritesPerRound: maxWrites
    })
    ctx.effect(() => {
        reports.interaction = () => runtime.report
        const tick = () => { void runtime.runRound() }
        const timer = setInterval(tick, config.interactionPollIntervalMinutes * 60_000)
        tick()
        return async () => {
            clearInterval(timer)
            reports.interaction = null
            await runtime.stop()
        }
    })
    ctx.on('bot-status-updated', () => {
        if (runtime.state.baseline !== 'ready' && qzone.status().bot) void runtime.runRound()
    })
}
