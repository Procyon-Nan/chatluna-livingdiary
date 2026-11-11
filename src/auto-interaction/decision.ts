import type { JsonValue, ToolSpec } from '@chatluna/ai'

export const interactionToolName = 'submit_qzone_interaction'
export const mediaToolName = 'read_qzone_media'
export type InteractionDecision = { action: 'skip' } | { action: 'publish'; content: string }

export const decisionTool: ToolSpec = {
    name: interactionToolName,
    description: '提交此次空间互动的最终决定：publish 携带评论或回复的完整正文，skip 跳过。',
    parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['publish', 'skip'] }, content: { type: 'string' }
    }, required: ['action'] }
}

export const mediaTool: ToolSpec = {
    name: mediaToolName,
    description: '按当前动态内的媒体编号读取标为 tool-readable 的图片。',
    parameters: { type: 'object', properties: { mediaIds: {
        type: 'array', items: { type: 'string' }, description: '1 至 9 个不同的可读取媒体编号，例如 M1、M2。'
    } }, required: ['mediaIds'] }
}

export function parseDecision(input: JsonValue): InteractionDecision {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        if (input.action === 'skip') return { action: 'skip' }
        if (input.action === 'publish' && typeof input.content === 'string' && input.content.trim()) {
            return { action: 'publish', content: input.content.trim() }
        }
    }
    throw new Error('action 必须为 skip 或 publish；publish 时 content 必须为非空正文。')
}

export function parseMediaIds(input: JsonValue, readable: ReadonlySet<string>): string[] {
    const ids = input && typeof input === 'object' && !Array.isArray(input) ? input.mediaIds : undefined
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 9 || new Set(ids).size !== ids.length ||
        !ids.every((id): id is string => typeof id === 'string' && readable.has(id))) {
        throw new Error('mediaIds 只能包含当前动态列为可读取的媒体编号，限 1 至 9 个且不能重复。')
    }
    return ids
}
