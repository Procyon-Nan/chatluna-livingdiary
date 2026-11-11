import Schema from 'schemastery'

export interface Config {
    platform: 'auto' | 'onebot' | 'milky'
    selfId?: string
    allowUserIds: string[]
    feedsDefaultLimit: number
    enablePublishTool: boolean
    rebindMinIntervalSeconds: number
    rebindBackoffSeconds: number
    rebindMaxConsecutiveFailures: number
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
        .description('连续续绑失败达到此次数后停止自动续绑，重载插件后恢复。')
})
