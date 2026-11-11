import Schema from 'schemastery'
import { modelAddressSchema } from '@chatluna/utils/model-address'
import type { Context } from 'cordis'
import type {} from '@chatluna/preset'
import type {} from '@chatluna/ui-schema-registry'

export interface Config {
    platform: 'auto' | 'onebot' | 'milky'
    selfId?: string
    allowUserIds: string[]
    feedsDefaultLimit: number
    enablePublishTool: boolean
    rebindMinIntervalSeconds: number
    rebindBackoffSeconds: number
    rebindMaxConsecutiveFailures: number
    personaPresetId: string
    mainModel: string
    enableDailyDigest: boolean
    digestTime: string
    digestMemoryLimit: number
    debug: boolean
}

const personaSelector = 'livingdiary-persona'

export function registerPersonaSelector(ctx: Context) {
    ctx.schemas.define(personaSelector, () => Schema.union(ctx.presets.list()
        .filter(preset => preset.status !== 'error' && (preset.kind === 'chat' || preset.kind === 'character'))
        .map(preset => Schema.const(preset.id).description(preset.name))))
    ctx.on('presets/change', () => ctx.schemas.invalidate(personaSelector))
}

export const Config: Schema<Config> = Schema.object({
    platform: Schema.union(['auto', 'onebot', 'milky']).default('auto')
        .description('获取 QQ 空间登录态的协议。自动选择时优先使用在线的 OneBot 机器人。'),
    selfId: Schema.string().description('绑定的机器人 QQ 号；留空时自动选择在线机器人。'),
    allowUserIds: Schema.array(Schema.string()).default([])
        .description('可使用空间命令和对话发布工具的 QQ 号；为空时无人可用。'),
    feedsDefaultLimit: Schema.number().min(1).max(10).step(1).default(5)
        .description('默认读取的空间动态条数。'),
    enablePublishTool: Schema.boolean().default(true).description('允许在对话中调用发布工具。'),
    rebindMinIntervalSeconds: Schema.number().min(0).default(60).description('两次续绑的最短间隔（秒）。'),
    rebindBackoffSeconds: Schema.number().min(0).default(60).description('续绑失败后的基础等待时间（秒）。'),
    rebindMaxConsecutiveFailures: Schema.number().min(1).step(1).default(3)
        .description('连续续绑失败达到此次数后停止自动续绑，重载插件后恢复。'),
    personaPresetId: Schema.string().role('dynamic', { name: personaSelector }).default('')
        .description('空间日记使用的预设，决定日记的口吻和记忆来源。'),
    mainModel: modelAddressSchema({ description: '撰写日记的模型。', modality: 'chat', roles: true, default: '' }),
    enableDailyDigest: Schema.boolean().default(false).description('每天定时撰写空间日记。'),
    digestTime: Schema.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('23:50')
        .description('每天开始写日记的时间，按服务器本地时间填写（HH:mm）。'),
    digestMemoryLimit: Schema.number().min(10).max(200).step(1).default(100)
        .description('写日记时最多参考多少条当天新建的活跃记忆，超出时取最近的。'),
    debug: Schema.boolean().default(false).description('在日志中显示日记提示词和模型响应。')
})
