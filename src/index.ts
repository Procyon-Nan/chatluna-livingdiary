import type { Context } from 'cordis'
import Schema from 'schemastery'

export const name = 'livingdiary'

export const inject = ['chatluna'] as const

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context) {
    ctx.logger.info('livingdiary loaded')
}
