import type { InteractionReport } from './auto-interaction/report.js'
import type { DailyDigestReport } from './daily-digest/report.js'

export interface RuntimeReports {
    digest: DailyDigestReport | null
    interaction: (() => InteractionReport) | null
}
