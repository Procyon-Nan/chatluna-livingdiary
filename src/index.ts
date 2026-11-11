import type { Context } from 'cordis'
import type { Config } from './config.js'
import { registerCommands } from './commands/index.js'
import { registerPublishTool } from './publishing/tool.js'
import { createQzoneService } from './qzone/service.js'

export { Config } from './config.js'

export const name = 'livingdiary'

export const inject = ['satori'] as const

export function apply(ctx: Context, config: Config) {
    const qzone = createQzoneService(ctx, config)
    ctx.effect(() => () => qzone.close())

    ctx.plugin({
        name: 'livingdiary-commands',
        inject: ['koishi'],
        apply: ctx => registerCommands(ctx, config, qzone)
    })
    if (config.enablePublishTool && config.allowUserIds.length) {
        ctx.plugin({
            name: 'livingdiary-publish-tool',
            inject: ['tools', 'agents'],
            apply: ctx => registerPublishTool(ctx, config, qzone)
        })
    }
}
