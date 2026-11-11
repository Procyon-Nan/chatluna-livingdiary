import type { Context } from 'cordis'
import type { QzoneManager } from '../qzone/manager.js'
import { publishOutcomeMessages, readableError } from '../publishing/publish.js'
import { decideDigest } from './model.js'
import { renderDiaryPersona } from './persona.js'
import { buildDigestPrompts, formatMemoryLines, type DigestMemoryEntry } from './prompt.js'
import type { DailyDigestReport, DailyDigestResult, DailyDigestTrigger } from './report.js'

export interface DigestSettings {
    presetId: string
    model: string
    memoryLimit: number
    debug?: boolean
}

/** LivingMemory 的插件根入口未导出服务类型；只描述本插件使用的公共读方法。 */
interface MemoryReader {
    repository: {
        listEntriesByPreset(presetId: string): Promise<readonly (DigestMemoryEntry & { status: 'active' | 'archived' })[]>
    }
}

export async function runDailyDigest(ctx: Context, qzone: Pick<QzoneManager, 'publish'>, settings: DigestSettings,
    trigger: DailyDigestTrigger, signal: AbortSignal, startedAt = new Date()): Promise<DailyDigestReport> {
    signal.throwIfAborted()
    const report = (result: DailyDigestResult, detail: string): DailyDigestReport => {
        let level: 'info' | 'warn' | 'error' = 'info'
        if (result === 'failed' || result === 'model-failed' || result === 'publish-failed') level = 'error'
        else if (result === 'preset-missing' || result === 'unknown') level = 'warn'
        ctx.logger[level]('每日总结：%s（%s）：%s', settings.presetId, trigger, detail)
        return { triggeredAt: startedAt.toISOString(), trigger, result, detail }
    }
    const preset = ctx.presets.get(settings.presetId)
    if (!preset || preset.status === 'error') return report('preset-missing', '配置的空间预设不存在或无法加载。')

    const midnight = new Date(startedAt)
    midnight.setHours(0, 0, 0, 0)
    let memories: DigestMemoryEntry[]
    try {
        const memory: MemoryReader = ctx.get('livingmemory')
        const rows = await memory.repository.listEntriesByPreset(preset.id)
        signal.throwIfAborted()
        memories = rows.filter(row => row.status === 'active' && row.createdAt >= midnight && row.createdAt <= startedAt)
            .sort((a, b) => +a.createdAt - +b.createdAt).slice(-settings.memoryLimit)
    } catch {
        signal.throwIfAborted()
        return report('failed', '读取当日记忆失败。')
    }
    if (!memories.length) return report('skipped-empty', '当日无记忆。')

    let persona: string
    try { persona = await renderDiaryPersona(ctx, preset, startedAt) }
    catch {
        signal.throwIfAborted()
        return report('preset-missing', '无法渲染空间预设的人设。')
    }
    signal.throwIfAborted()
    if (!persona) return report('preset-missing', '空间预设的人设为空。')
    const prompts = buildDigestPrompts({
        assistantLabel: preset.name, persona, memoryCount: memories.length, memoryLines: formatMemoryLines(memories),
        dateText: startedAt.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    })
    let content: string
    try {
        const decision = await decideDigest(ctx, settings.model, prompts, signal, settings.debug ?? false)
        signal.throwIfAborted()
        if (decision.action === 'skip') return report('skipped-by-model', '没有可发布内容。')
        content = decision.content
    } catch (error) {
        signal.throwIfAborted()
        return report('model-failed', (error as Error).message)
    }
    // 写入后保留 SDK 给出的结果；中途停用只等待收尾，不重发。
    try {
        const { outcome } = await qzone.publish({ content, signal })
        const result = outcome === 'accepted' || outcome === 'unknown' ? outcome : 'published'
        return report(result, publishOutcomeMessages[outcome])
    } catch (error) {
        signal.throwIfAborted()
        return report('publish-failed', readableError(error, '发布每日动态失败'))
    }
}
