export type DailyDigestTrigger = 'scheduled' | 'manual'

export type DailyDigestResult =
    | 'published'
    | 'skipped-empty'
    | 'skipped-by-model'
    | 'model-failed'
    | 'publish-failed'
    | 'preset-missing'
    | 'failed'

export interface DailyDigestReport {
    readonly triggeredAt: string
    readonly trigger: DailyDigestTrigger
    readonly result: DailyDigestResult
    readonly detail: string
}

export const dailyDigestResultLabels: Record<DailyDigestResult, string> = {
    published: '已发布',
    'skipped-empty': '跳过（当日无记忆）',
    'skipped-by-model': '模型判定跳过',
    'model-failed': '模型生成失败',
    'publish-failed': '发布失败',
    'preset-missing': '配置的预设不可用',
    failed: '执行失败'
}
