import type { Context } from 'cordis'
import { h } from '@satorijs/core'
import type {} from 'koishi'
import type { Config } from '../config.js'
import { isUserAllowed } from '../access.js'
import { publishPost, readableError } from '../publishing/publish.js'
import type { QzoneService } from '../qzone/service.js'
import type { RuntimeReports } from '../daily-digest/report.js'
import { formatFeedList, formatStatus } from './format.js'

export const FEEDS_LIMIT_MAX = 10

export function clampFeedCount(
    count: number | undefined,
    defaultLimit: number
): number {
    const value = count ?? defaultLimit
    return Math.min(Math.max(Math.trunc(value) || 1, 1), FEEDS_LIMIT_MAX)
}

export interface PublishParts {
    readonly content: string
    readonly imageUrls: readonly string[]
}

/**
 * 拆分发布指令的元素参数：正文取顶层 text 元素，配图取顶层 img 元素。
 *
 * 只遍历顶层，不递归子树：QQ 表情（face）内嵌的 CDN 图片不应成为
 * 配图，引用等其余元素及其子树一律丢弃（内容不进入正文）。
 */
export function extractPublishParts(elements: readonly h[]): PublishParts {
    let content = ''
    const imageUrls: string[] = []
    for (const element of elements) {
        if (element.type === 'text') {
            content += String(element.attrs.content ?? '')
        } else if (element.type === 'img') {
            const src = element.attrs.src ?? element.attrs.url
            if (typeof src === 'string' && src) {
                imageUrls.push(src)
            }
        }
    }
    return { content: content.trim(), imageUrls }
}

export function registerCommands(ctx: Context, config: Config, service: QzoneService, reports: RuntimeReports): void {
    const owner = 'livingdiary'
    const denial = '未授权：你的账号不在 allowUserIds 白名单中。'
    const usage = '子指令：qzone.feeds 读取动态；qzone.publish 发布动态（可附图）；qzone.status 查看状态；qzone.digest 根据今天的记忆写日记（需 LivingMemory 和模型服务）。'

    ctx.command('qzone', 'QQ 空间生活日记', { owner }).usage(usage).action(() => usage)
    ctx.command('qzone.feeds [count:posint]', '读取 QQ 空间动态', { owner })
        .option('target', '-t <qq:string> 读取指定 QQ 的公开动态，默认读取自己')
        .action(async ({ session, options }, count) => {
            if (!isUserAllowed(session?.userId, config.allowUserIds, session?.platform)) return denial
            const limit = clampFeedCount(count, config.feedsDefaultLimit)
            try {
                const target = options?.target
                const page = target
                    ? await service.listFeedPage({ scope: 'profile', userId: target, limit })
                    : await service.listFeedPage({ scope: 'self', limit })
                return h.escape(formatFeedList(page.items))
            } catch (error) {
                return h.escape(readableError(error, '读取动态失败'))
            }
        })
    ctx.command('qzone.publish <content:elements>', '发布动态到 QQ 空间（可附图，最多九张）', { owner })
        .action(async ({ session }, content) => {
            if (!isUserAllowed(session?.userId, config.allowUserIds, session?.platform)) return denial
            const parts = extractPublishParts(content ?? [])
            const result = await publishPost(ctx, service, { content: parts.content, images: parts.imageUrls })
            return h.escape(result.message)
        })
    ctx.command('qzone.status', '查看 QQ 空间登录态', { owner })
        .action(({ session }) => isUserAllowed(session?.userId, config.allowUserIds, session?.platform)
            ? formatStatus(service.status(), reports.digest)
            : denial)
}
