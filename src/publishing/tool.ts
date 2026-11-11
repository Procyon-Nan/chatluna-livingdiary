import type { Context } from 'cordis'
import type { PermissionSubject, Speaker } from '@chatluna/permission'
import type {} from '@chatluna/tool'
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

function actsForRequester(requester: { user: string; platform?: string }, subject: PermissionSubject) {
    return subject.user === requester.user && (subject.platform === undefined || subject.platform === requester.platform)
}

export function registerPublishTool(ctx: Context, config: Config, qzone: Pick<QzoneManager, 'publish'>) {
    ctx.tools.define<PublishInput & { for?: string }>({
        name,
        description: 'Publish a post to the bot’s QQ Space for the requesting user. Use image addresses from this conversation.',
        locales: { zh: { description: '将本次对话提供的正文和图片发布到机器人的 QQ 空间。' } },
        args: Schema.object({
            content: Schema.string().required().description('Post text; pass an empty string for an image-only post.'),
            images: Schema.array(Schema.string()).description('Up to 9 image references from the conversation.')
        }),
        traits: { effect: 'write', parallel: false, background: false },
        async run(input, call) {
            const requester = authorizedRequester(call.speakers ?? [], call.location?.platform, config.allowUserIds)
            if (!requester || (input.for !== undefined && input.for !== requester.user) ||
                (call.actor && !actsForRequester(requester, call.actor))) {
                throw new Error(denied)
            }
            return publishPost(ctx, qzone, input, call.signal)
        }
    })
}
