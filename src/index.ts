import type { Context } from 'cordis'
import type { Config } from './config.js'
import { registerPersonaSelector } from './config.js'
import { registerCommands } from './commands/index.js'
import { registerDailyDigest } from './daily-digest/index.js'
import { registerAutoInteraction } from './auto-interaction/index.js'
import type { RuntimeReports } from './status.js'
import { registerPublishTool } from './publishing/tool.js'
import { createQzoneService } from './qzone/service.js'
import { createDiaryJournal } from './journal/repository.js'
import { registerWebUI } from './webui.js'

export { Config } from './config.js'

export const name = 'livingdiary'

export const inject = ['satori'] as const

export function apply(ctx: Context, config: Config) {
    const qzone = createQzoneService(ctx, config)
    ctx.effect(() => () => qzone.close())
    const reports: RuntimeReports = { digest: null, interaction: null }
    ctx.inject(['schemas', 'presets'], registerPersonaSelector)

    ctx.plugin({
        name: 'livingdiary-commands',
        inject: ['koishi'],
        apply: ctx => registerCommands(ctx, config, qzone, reports)
    })
    ctx.inject(['model', 'database'], scope => {
        const journal = createDiaryJournal(scope)
        scope.plugin({
            name: 'livingdiary-daily-digest',
            inject: ['livingmemory', 'presets', 'prompt', 'chatluna', 'ai'],
            apply: ctx => registerDailyDigest(ctx, config, qzone, reports, journal)
        })
        scope.inject(['chatluna_webui', 'presets'], ui => registerWebUI(ui, ctx, journal, config.personaPresetId.trim()))
    })
    ctx.plugin({
        name: 'livingdiary-auto-interaction',
        inject: ['satori', 'presets', 'prompt', 'chatluna', 'ai'],
        apply: ctx => registerAutoInteraction(ctx, config, qzone, reports)
    })
    if (config.enablePublishTool) {
        ctx.plugin({
            name: 'livingdiary-publish-tool',
            inject: ['tools'],
            apply: ctx => registerPublishTool(ctx, config, qzone)
        })
    }
}
