import { h } from '@satorijs/core'
import type { Context } from 'cordis'
import type {} from 'koishi'
import { isUserAllowed } from '../access.js'
import type { Config } from '../config.js'
import type { QzoneManager } from '../qzone/manager.js'
import type { RuntimeReports } from '../status.js'
import { dailyDigestResultLabels } from './report.js'
import { DailyDigestRuntime } from './runtime.js'
import { runDailyDigest } from './workflow.js'

export function registerDailyDigest(ctx: Context, config: Config, qzone: Pick<QzoneManager, 'publish'>, reports: RuntimeReports) {
    const settings = {
        presetId: config.personaPresetId.trim(),
        model: config.mainModel.trim(),
        memoryLimit: config.digestMemoryLimit,
        debug: config.debug
    }
    const missing: string[] = []
    if (!settings.presetId) missing.push('人设预设')
    if (!settings.model) missing.push('主模型')
    const runtime = new DailyDigestRuntime(
        (trigger, signal, startedAt) => runDailyDigest(ctx, qzone, settings, trigger, signal, startedAt),
        reports, ctx.logger
    )
    ctx.effect(() => () => runtime.stop())

    ctx.plugin({
        name: 'livingdiary-digest-command',
        inject: ['koishi'],
        apply(ctx) {
            ctx.command('qzone.digest', '根据今天的记忆写一篇空间日记', { owner: 'livingdiary' })
                .action(async ({ session }) => {
                    if (!isUserAllowed(session?.userId, config.allowUserIds, session?.platform)) {
                        return '未授权：你的账号不在 allowUserIds 白名单中。'
                    }
                    if (missing.length) return `请先在插件配置中设置${missing.join('、')}。`
                    try {
                        const task = runtime.run('manual')
                        if (!task) return '已有日记任务执行中，请稍后再试。'
                        const { result, detail } = await task
                        const label = dailyDigestResultLabels[result]
                        return h.escape(detail ? `${label}：${detail}` : label)
                    } catch (error) {
                        if (runtime.stopped) return '插件已停止，本次日记任务已取消。'
                        throw error
                    }
                })
        }
    })
    if (!config.enableDailyDigest) return
    if (missing.length) {
        ctx.logger.warn(`每日日记：尚未设置${missing.join('、')}，未启用定时任务`)
        return
    }
    const [hour, minute] = config.digestTime.split(':').map(Number)
    runtime.schedule({ hour, minute })
}
