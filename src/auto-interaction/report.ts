export type InteractionPhase =
    | 'disabled'
    | 'waiting-config'
    | 'waiting-bot'
    | 'baselining'
    | 'ready'
    | 'running'
    | 'failed'

export interface InteractionRoundStats {
    readonly discovered: number
    readonly modelSkipped: number
    readonly writeAttempts: number
    readonly verified: number
    readonly accepted: number
    readonly unknown: number
    readonly incompleteSnapshots: number
    readonly feedPageLimitHits: number
    readonly errors: number
}

export type InteractionErrorKind =
    | 'baseline'
    | 'monitored-read'
    | 'round-read'
    | 'detail-refresh'
    | 'persona'
    | 'model-unavailable'
    | 'model-decision'
    | 'write-auth'
    | 'write'

export interface InteractionReport {
    readonly phase: InteractionPhase
    readonly detail: string
    readonly baselineCompletedAt: string | null
    readonly roundStartedAt: string | null
    readonly lastRoundAt: string | null
    readonly monitoredPosts: number
    readonly monitorLimit: number
    readonly pendingTriggers: number
    readonly maxWritesPerRound: number
    readonly round: InteractionRoundStats | null
    readonly lastError: InteractionErrorKind | null
}

export function initialInteractionReport(
    phase: 'disabled' | 'waiting-config' | 'waiting-bot', detail: string,
    monitorLimit: number, maxWritesPerRound: number
): InteractionReport {
    return { phase, detail, monitorLimit, maxWritesPerRound,
        baselineCompletedAt: null, roundStartedAt: null, lastRoundAt: null,
        monitoredPosts: 0, pendingTriggers: 0, round: null, lastError: null }
}

const phaseLabels: Record<InteractionPhase, string> = {
    disabled: '未启用',
    'waiting-config': '配置不完整',
    'waiting-bot': '等待机器人上线',
    baselining: '正在建立启动基线',
    ready: '就绪',
    running: '轮询中',
    failed: '最近执行失败'
}

const errorLabels: Record<InteractionErrorKind, string> = {
    baseline: '启动基线',
    'monitored-read': '监控详情读取',
    'round-read': '轮询读取',
    'detail-refresh': '写前或写后详情刷新',
    persona: '人设渲染',
    'model-unavailable': '互动模型不可用',
    'model-decision': '模型决策',
    'write-auth': '写入登录态',
    write: '写入请求'
}

const formatReportTime = (value: string | null): string => {
    if (value === null) return '无'
    const date = new Date(value)
    return Number.isNaN(date.getTime())
        ? value
        : date.toLocaleString('zh-CN', { hour12: false })
}

export function emptyRoundStats(): InteractionRoundStats {
    return {
        discovered: 0,
        modelSkipped: 0,
        writeAttempts: 0,
        verified: 0,
        accepted: 0,
        unknown: 0,
        incompleteSnapshots: 0,
        feedPageLimitHits: 0,
        errors: 0
    }
}

export function formatInteractionLine(
    report: InteractionReport | null
): string {
    if (report === null) return 'QQ空间自动互动：未运行'
    const base =
        `QQ空间自动互动：${phaseLabels[report.phase]}` +
        `；监控 ${report.monitoredPosts}/${report.monitorLimit}` +
        `；待处理 ${report.pendingTriggers}` +
        `；基线 ${formatReportTime(report.baselineCompletedAt)}`
    if (report.round === null) {
        return report.detail ? `${base}；${report.detail}` : base
    }
    const round = report.round
    const diagnostics: string[] = []
    if (round.incompleteSnapshots > 0) {
        diagnostics.push(`不完整快照 ${round.incompleteSnapshots}`)
    }
    if (round.feedPageLimitHits > 0) {
        diagnostics.push(`Feed 上限 ${round.feedPageLimitHits}`)
    }
    if (round.errors > 0) {
        diagnostics.push(
            `错误 ${round.errors}` +
                (report.lastError ? `（${errorLabels[report.lastError]}）` : '')
        )
    }
    return (
        `${base}；轮次 ${formatReportTime(report.roundStartedAt)} → ` +
        `${formatReportTime(report.lastRoundAt)}` +
        `；发现 ${round.discovered}，模型跳过 ${round.modelSkipped}` +
        `；写入 ${round.writeAttempts}/` +
        `${report.maxWritesPerRound}（已确认 ${round.verified}，` +
        `已受理 ${round.accepted}，待核对 ${round.unknown}）` +
        (diagnostics.length > 0 ? `；${diagnostics.join('，')}` : '')
    )
}
