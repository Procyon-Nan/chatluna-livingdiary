import type { Context, Disposable } from 'cordis'
import { speakersOf, type Agent } from '@chatluna/agent'
import type { PermissionSubject, Speaker } from '@chatluna/permission'
import type { ToolDefinition } from '@chatluna/tool'
import { kAgent } from '@chatluna/utils/agent-local'
import Schema from 'schemastery'
import { isUserAllowed } from '../access.js'
import type { Config } from '../config.js'
import type { QzoneManager } from '../qzone/manager.js'
import { publishPost, type PublishInput } from './publish.js'

const name = 'qzone_publish'
const denied = '仅允许白名单中的 QQ 用户为自己请求发布动态。'

/** 同轮其他人可以发言；只有明确请求者能授权。多人均直接呼叫时无法归属本次发帖。 */
function authorizedRequester(speakers: readonly Speaker[], platform: string | undefined, allowed: readonly string[]) {
    const addressed = speakers.filter(speaker => speaker.addressed)
    const candidates = addressed.length ? addressed : speakers
    if (candidates.length !== 1) return
    const [requester] = candidates
    const origin = requester.platform ?? platform
    if (isUserAllowed(requester.user, allowed, origin)) return { user: requester.user, platform: origin }
}

/** 请求者必须与开轮时一致；框架固定或模型指定的代发身份也必须是本人。 */
function actsForRequester(requester: { user: string; platform?: string }, subject: PermissionSubject) {
    return subject.user === requester.user && (subject.platform === undefined || subject.platform === requester.platform)
}

export function registerPublishTool(ctx: Context, config: Config, qzone: Pick<QzoneManager, 'publish'>) {
    const active = new WeakMap<Agent, Disposable>()
    function release(agent: Agent) {
        active.get(agent)?.()
        active.delete(agent)
    }
    const tool: Omit<ToolDefinition<PublishInput & { for?: string }>, 'run'> = {
        name,
        description: 'Publish a post to the bot’s QQ Space for the requesting user. Use image addresses from this conversation.',
        locales: { zh: { description: '将本次对话提供的正文和图片发布到机器人的 QQ 空间。' } },
        args: Schema.object({
            content: Schema.string().required().description('Post text; pass an empty string for an image-only post.'),
            images: Schema.array(Schema.string()).description('Up to 9 image references from the conversation.')
        }),
        traits: { effect: 'write', parallel: false, background: false }
    }
    ctx.on('agent/before-turn', ({ agent, input }) => {
        release(agent)
        const requester = authorizedRequester(speakersOf(input), agent.options.location?.platform, config.allowUserIds)
        if (!requester) return
        // 工具只属于本轮 Agent，注册的生命周期仍属于插件，热卸载同时撤销。
        const scoped = ctx.extend({ [kAgent]: agent })
        const unregister = scoped.tools.define<PublishInput & { for?: string }>({
            ...tool,
            async run(input, call) {
                const current = authorizedRequester(call.speakers ?? [], call.location?.platform, config.allowUserIds)
                if (!current || !actsForRequester(requester, current)) return { outcome: 'failed', message: denied }
                if (input.for !== undefined && input.for !== requester.user) return { outcome: 'failed', message: denied }
                if (call.actor && !actsForRequester(requester, call.actor)) return { outcome: 'failed', message: denied }
                return publishPost(ctx, qzone, input, call.signal)
            }
        })
        active.set(agent, unregister)
    })
    ctx.on('chatluna/agent-turn', ({ agent }) => release(agent))
    ctx.on('agent/turn-failed', ({ agent }) => release(agent))
    ctx.on('chatluna/agent-close', ({ agent }) => release(agent))
}
