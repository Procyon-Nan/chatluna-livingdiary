import type {
    CommentReference,
    PostReference,
    QzoneComment,
    QzonePost
} from 'qzone-sdk'

export type InteractionTriggerKind =
    'friend-thread-reply' | 'self-comment' | 'friend-post'

export interface PendingTrigger {
    readonly key: string
    readonly kind: InteractionTriggerKind
    readonly post: PostReference
    readonly commentKey: string | null
    readonly occurredAt: number | null
    readonly detectedAt: number
}

export interface MonitoredPost {
    readonly key: string
    post: PostReference
    readonly owner: 'self' | 'friend'
    activityAt: number
    baselineReady: boolean
    botThreadRoot: CommentReference | null
    /** 启动基线截止时间；晚到但不晚于该时刻的有时间节点仍视为历史。 */
    ignoreCommentsThrough: number | null
    /** 首个基线后完整快照中，无时间节点也按历史处理；完成后解除。 */
    baselineObservationPending: boolean
    readonly seenComments: Set<string>
}

export interface FeedWatermark {
    readonly timestamp: number
    readonly keysAtTimestamp: ReadonlySet<string>
}

export interface InteractionRuntimeState {
    baseline: 'pending' | 'ready'
    baselineCompletedAt: number | null
    friendFeedWatermark: FeedWatermark | null
    readonly monitoredPosts: Map<string, MonitoredPost>
    readonly pendingTriggers: Map<string, PendingTrigger>
}

const timestampOf = (value: string | null): number | null => {
    if (value === null) return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
}

export function postKey(post: PostReference): string {
    return `${post.authorId}:${post.id}`
}

export function sameCommentReference(
    left: CommentReference | null,
    right: CommentReference | null
): boolean {
    if (left === null || right === null) return left === right
    return left.id === right.id && left.authorId === right.authorId
}

export function commentKey(post: PostReference, comment: QzoneComment): string {
    return [
        postKey(post),
        comment.kind,
        comment.threadRoot?.authorId ?? '-',
        comment.threadRoot?.id ?? '-',
        comment.author.id,
        comment.id
    ].join(':')
}

export function triggerKey(
    kind: InteractionTriggerKind,
    post: PostReference,
    nodeKey: string | null = null
): string {
    return `${kind}:${postKey(post)}:${nodeKey ?? '-'}`
}

export function createInteractionRuntimeState(): InteractionRuntimeState {
    return {
        baseline: 'pending',
        baselineCompletedAt: null,
        friendFeedWatermark: null,
        monitoredPosts: new Map(),
        pendingTriggers: new Map()
    }
}

export function normalizeInteractionAllowList(values: readonly string[]): {
    readonly ids: ReadonlySet<string>
    readonly invalidCount: number
} {
    const ids = new Set<string>()
    let invalidCount = 0
    for (const value of values) {
        const normalized = value.trim()
        if (!/^\d+$/u.test(normalized)) {
            invalidCount += 1
            continue
        }
        ids.add(normalized)
    }
    return { ids, invalidCount }
}

export function isInteractionActorAllowed(
    actorId: string,
    whitelistEnabled: boolean,
    allowIds: ReadonlySet<string>
): boolean {
    return !whitelistEnabled || allowIds.has(actorId)
}

export function createMonitoredPost(
    post: PostReference,
    owner: 'self' | 'friend',
    activityAt: number,
    baselineReady: boolean,
    botThreadRoot: CommentReference | null = null
): MonitoredPost {
    return {
        key: postKey(post),
        post: { id: post.id, authorId: post.authorId },
        owner,
        activityAt,
        baselineReady,
        botThreadRoot,
        ignoreCommentsThrough: null,
        baselineObservationPending: false,
        seenComments: new Set()
    }
}

export function baselineMonitoredPost(
    monitored: MonitoredPost,
    detail: QzonePost,
    detectedAt: number
): void {
    if (!detail.commentsComplete) return
    monitored.post = { id: detail.id, authorId: detail.authorId }
    monitored.seenComments.clear()
    for (const comment of detail.comments) {
        monitored.seenComments.add(commentKey(detail, comment))
    }
    monitored.baselineReady = true
    monitored.ignoreCommentsThrough = null
    monitored.baselineObservationPending = false
    monitored.activityAt = Math.max(
        monitored.activityAt,
        timestampOf(detail.createdAt) ?? detectedAt,
        ...detail.comments.map(
            (comment) => timestampOf(comment.createdAt) ?? detectedAt
        )
    )
}

export interface DiscoverCommentsOptions {
    readonly botId: string
    readonly whitelistEnabled: boolean
    readonly allowIds: ReadonlySet<string>
    readonly detectedAt: number
}

/**
 * 从完整详情中发现新增评论。新节点先写 seen，再决定是否生成触发，确保
 * Bot、自名单外用户和无关线程不会在后续轮次重复判定。
 */
export function discoverCommentTriggers(
    monitored: MonitoredPost,
    detail: QzonePost,
    options: DiscoverCommentsOptions
): readonly PendingTrigger[] {
    if (!detail.commentsComplete) return []
    if (!monitored.baselineReady) {
        baselineMonitoredPost(monitored, detail, options.detectedAt)
        return []
    }

    const triggers: PendingTrigger[] = []
    const ignoreThrough = monitored.ignoreCommentsThrough
    const ignoreUndated = monitored.baselineObservationPending
    monitored.post = { id: detail.id, authorId: detail.authorId }
    for (const comment of detail.comments) {
        const nodeKey = commentKey(detail, comment)
        if (monitored.seenComments.has(nodeKey)) continue
        monitored.seenComments.add(nodeKey)
        const occurredAt = timestampOf(comment.createdAt)
        monitored.activityAt = Math.max(
            monitored.activityAt,
            occurredAt ?? options.detectedAt
        )
        if (
            ignoreThrough !== null &&
            (occurredAt === null ? ignoreUndated : occurredAt <= ignoreThrough)
        ) {
            continue
        }
        if (comment.author.id === options.botId) continue
        if (
            !isInteractionActorAllowed(
                comment.author.id,
                options.whitelistEnabled,
                options.allowIds
            )
        ) {
            continue
        }
        const kind: InteractionTriggerKind =
            monitored.owner === 'self' ? 'self-comment' : 'friend-thread-reply'
        if (
            monitored.owner === 'friend' &&
            (comment.kind !== 'reply' ||
                !sameCommentReference(
                    comment.threadRoot,
                    monitored.botThreadRoot
                ))
        ) {
            continue
        }
        triggers.push({
            key: triggerKey(kind, detail, nodeKey),
            kind,
            post: { id: detail.id, authorId: detail.authorId },
            commentKey: nodeKey,
            occurredAt,
            detectedAt: options.detectedAt
        })
    }
    monitored.baselineObservationPending = false
    return triggers
}

export function createFriendPostTrigger(
    post: QzonePost,
    detectedAt: number
): PendingTrigger {
    return {
        key: triggerKey('friend-post', post),
        kind: 'friend-post',
        post: { id: post.id, authorId: post.authorId },
        commentKey: null,
        occurredAt: timestampOf(post.createdAt),
        detectedAt
    }
}

export function enqueueTrigger(
    state: InteractionRuntimeState,
    trigger: PendingTrigger
): boolean {
    if (state.pendingTriggers.has(trigger.key)) {
        return false
    }
    state.pendingTriggers.set(trigger.key, trigger)
    return true
}

const triggerPriority: Record<InteractionTriggerKind, number> = {
    'friend-thread-reply': 0,
    'self-comment': 1,
    'friend-post': 2
}

export function sortPendingTriggers(
    values: Iterable<PendingTrigger>
): PendingTrigger[] {
    return [...values].sort((left, right) => {
        const priority =
            triggerPriority[left.kind] - triggerPriority[right.kind]
        if (priority !== 0) return priority
        const leftAt = left.occurredAt ?? left.detectedAt
        const rightAt = right.occurredAt ?? right.detectedAt
        return leftAt - rightAt || left.key.localeCompare(right.key)
    })
}

export function removeMonitoredPost(
    state: InteractionRuntimeState,
    key: string
): void {
    state.monitoredPosts.delete(key)
    for (const [triggerId, trigger] of state.pendingTriggers) {
        if (postKey(trigger.post) === key) {
            state.pendingTriggers.delete(triggerId)
        }
    }
}

export function trimMonitoredPosts(
    state: InteractionRuntimeState,
    limit: number
): readonly string[] {
    const keep = [...state.monitoredPosts.values()]
        .sort(
            (left, right) =>
                right.activityAt - left.activityAt ||
                left.key.localeCompare(right.key)
        )
        .slice(0, Math.max(0, limit))
    const keepKeys = new Set(keep.map((item) => item.key))
    const evicted: string[] = []
    for (const key of state.monitoredPosts.keys()) {
        if (keepKeys.has(key)) continue
        removeMonitoredPost(state, key)
        evicted.push(key)
    }
    return evicted
}

export function findCommentByKey(
    detail: QzonePost,
    expectedKey: string
): QzoneComment | null {
    return (
        detail.comments.find(
            (comment) => commentKey(detail, comment) === expectedKey
        ) ?? null
    )
}

export function createFeedWatermark(
    posts: readonly QzonePost[],
    fallbackTimestamp: number
): FeedWatermark {
    const valid = posts
        .map((post) => ({
            key: postKey(post),
            at: timestampOf(post.createdAt)
        }))
        .filter((item): item is { key: string; at: number } => item.at !== null)
    const timestamp =
        valid.length === 0
            ? fallbackTimestamp
            : Math.max(...valid.map((item) => item.at))
    return {
        timestamp,
        keysAtTimestamp: new Set(
            valid
                .filter((item) => item.at === timestamp)
                .map((item) => item.key)
        )
    }
}

export function advanceFeedWatermark(
    current: FeedWatermark,
    posts: readonly QzonePost[]
): FeedWatermark {
    const next = createFeedWatermark(posts, current.timestamp)
    if (next.timestamp < current.timestamp) return current
    if (next.timestamp > current.timestamp) return next
    return {
        timestamp: current.timestamp,
        keysAtTimestamp: new Set([
            ...current.keysAtTimestamp,
            ...next.keysAtTimestamp
        ])
    }
}

export function isPostAfterWatermark(
    post: QzonePost,
    watermark: FeedWatermark
): boolean {
    const at = timestampOf(post.createdAt)
    if (at === null || at < watermark.timestamp) return false
    return (
        at > watermark.timestamp ||
        !watermark.keysAtTimestamp.has(postKey(post))
    )
}

export function isCommentInBotThread(
    comment: QzoneComment,
    threadRoot: CommentReference
): boolean {
    return (
        comment.kind === 'reply' &&
        sameCommentReference(comment.threadRoot, threadRoot)
    )
}
