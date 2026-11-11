import type { QzonePost } from 'qzone-sdk'
import { cookiePlatformLabel } from '../qzone/cookie-source.js'
import type { LivingDiaryStatus } from '../qzone/service.js'

const CONTENT_SLICE_LENGTH = 100

export function sliceContent(
    content: string,
    maxLength = CONTENT_SLICE_LENGTH
): string {
    const flat = content.replace(/\s+/g, ' ').trim()
    return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat
}

export function formatTime(value: string | number | null): string {
    if (value === null) return '未知'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString('zh-CN', { hour12: false })
}

const formatEpochSeconds = (value: number | null): string =>
    formatTime(value === null ? null : value * 1000)

export function formatFeedList(items: readonly QzonePost[]): string {
    if (items.length === 0) return '没有获取到动态。'
    return items
        .map((post, index) => {
            const liked = post.liked ? '・已赞' : ''
            return (
                `${index + 1}. ${formatTime(post.createdAt)} ` +
                `${post.author.nickname}：${sliceContent(post.content)}` +
                `（赞 ${post.likeCount}・评论 ${post.commentCount}${liked}）`
            )
        })
        .join('\n')
}

export function formatStatus(
    status: LivingDiaryStatus
): string {
    const lines: string[] = []
    lines.push(
        status.bot
            ? `机器人（${cookiePlatformLabel(status.bot.platform)}）：` +
                  `${status.bot.selfId}（在线）`
            : '机器人：未找到（检查机器人是否在线或 platform/selfId 配置）'
    )
    if (status.client.initialized) {
        lines.push(
            `空间客户端：已初始化（账号 ${status.client.accountId ?? '未知'}）`
        )
        lines.push(`登录态：${status.client.authenticated ? '有效' : '无效'}`)
        lines.push(
            `Session 更新：${formatTime(status.client.sessionUpdatedAt)}`
        )
    } else {
        lines.push(
            '空间客户端：未初始化（首次使用 qzone.feeds / qzone.publish 时自动初始化）'
        )
    }
    const rebind = status.client.rebind
    if (rebind.disabled) {
        lines.push(
            '自动续绑：已停用（连续失败达到上限，处理登录态后重载插件恢复）'
        )
    } else if (rebind.consecutiveFailures > 0) {
        lines.push(
            `自动续绑：连续失败 ${rebind.consecutiveFailures} 次，` +
                `下次允许 ${formatEpochSeconds(rebind.nextAllowedAtSeconds)}`
        )
    } else {
        lines.push('自动续绑：正常')
    }
    return lines.join('\n')
}
