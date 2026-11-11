import type { Context } from 'cordis'
import type { ChatSpecMessage, ChatToolCallBlock, ToolOutput } from '@chatluna/ai'
import type { QzoneComment, QzonePost } from 'qzone-sdk'
import { callModel } from '../model.js'
import { decisionTool, interactionToolName, mediaTool, mediaToolName,
    parseDecision, parseMediaIds, type InteractionDecision } from './decision.js'
import { prepareInteractionMedia } from './media.js'
import { buildInteractionPrompt } from './prompt.js'
import type { PendingTrigger } from './state.js'

interface InteractionOptions {
    model: string
    persona: string
    assistantLabel: string
    detail: QzonePost
    trigger: PendingTrigger
    activeComment: QzoneComment | null
    debug: boolean
}

function reportResults(messages: ChatSpecMessage[], calls: readonly ChatToolCallBlock[], output: ToolOutput) {
    if (!calls.length) {
        messages.push({ role: 'user', content: [{ type: 'text', text: '请调用结果工具提交决定，普通文本不能提交。' }] })
        return
    }
    messages.push({ role: 'assistant', content: calls }, { role: 'tool', content: calls.map(call => ({
        type: 'tool-result', toolName: call.toolName, toolCallId: call.toolCallId, output
    })) })
}

/** 三步内只读取本条动态的媒体并给出一次决定；实际评论和回复由轮询任务执行。 */
export async function decideInteraction(ctx: Context, options: InteractionOptions, signal: AbortSignal): Promise<InteractionDecision> {
    const media = await prepareInteractionMedia(ctx, options.detail.media, options.model, signal)
    const { systemPrompt, inputMessage } = buildInteractionPrompt({ ...options, media })
    const messages = [inputMessage]
    const toolSpecs = media.readable.size ? [decisionTool, mediaTool] : [decisionTool]
    let reason = '模型未提交决定'
    for (let step = 1; step <= 3; step++) {
        if (options.debug) {
            const summary = JSON.stringify({ system: systemPrompt, messages }, (_key, value) =>
                value?.type === 'data' && typeof value.data === 'string' ? { type: 'data', size: value.data.length } : value)
            ctx.logger.info('自动互动：model.prompt（%s，第 %d 步）\n%s', options.model, step, summary)
        }
        const result = await callModel(ctx, { model: options.model, system: systemPrompt, messages: [...messages],
            toolSpecs, toolChoice: 'required', purpose: 'livingdiary.interaction', cache: false }, signal)
        if (options.debug) ctx.logger.info('自动互动：model.response（%s，第 %d 步）\n%s',
            options.model, step, JSON.stringify(result.content))
        const calls = result.toolCalls
        if (calls.length === 1) {
            const [call] = calls
            try {
                if (call.toolName === interactionToolName) return parseDecision(call.input)
                if (call.toolName === mediaToolName && media.readable.size) {
                    const ids = parseMediaIds(call.input, media.readable)
                    if (step === 3) {
                        reason = '最后一步仍在请求读取媒体'
                        break
                    }
                    reportResults(messages, calls, { type: 'content', value: await media.read(ids) })
                    continue
                }
                reason = '此工具不属于本次空间互动。'
            } catch (error) {
                signal.throwIfAborted()
                reason = (error as Error).message
            }
        } else {
            reason = '每一步只能调用一次工具，读取媒体后须等待结果再提交决定。'
        }
        reportResults(messages, calls, { type: 'error-text', value: reason })
    }
    throw new Error(`自动互动在 3 步内未完成：${reason}`)
}
