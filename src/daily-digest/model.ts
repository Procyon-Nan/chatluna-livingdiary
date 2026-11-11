import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from 'cordis'
import type {} from '@chatluna/core'
import type {} from '@chatluna/ai-runtime/ops'
import type { ChatSpecMessage, ChatToolCallBlock, ToolSpec } from '@chatluna/ai'
import { digestToolName } from './prompt.js'

const decisionTool: ToolSpec = {
    name: digestToolName,
    description: '提交每日动态的最终决定：publish 携带动态全文，skip 跳过。',
    parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['publish', 'skip'] }, content: { type: 'string' } },
        required: ['action']
    }
}

type Decision = { action: 'skip' } | { action: 'publish'; content: string }

function decisionOf(calls: readonly ChatToolCallBlock[]): Decision {
    if (calls.length !== 1 || calls[0].toolName !== digestToolName) {
        throw new Error(`必须且只能调用 ${digestToolName} 一次。`)
    }
    let input = calls[0].input
    if (typeof input === 'string') {
        try { input = JSON.parse(input) }
        catch { throw new Error('工具参数不是有效的 JSON 对象。') }
    }
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        if (input.action === 'skip') return { action: 'skip' }
        if (input.action === 'publish' && typeof input.content === 'string' && input.content.trim()) {
            return { action: 'publish', content: input.content }
        }
    }
    throw new Error('action 必须为 skip 或 publish；publish 时 content 必须为非空正文。')
}

function correction(calls: readonly ChatToolCallBlock[], reason: string): ChatSpecMessage[] {
    const text = `结构化结果无效：${reason} 请完整修正参数，不要在普通文本中输出结果。`
    if (!calls.length) return [{ role: 'user', content: [{ type: 'text', text }] }]
    return [
        { role: 'assistant', content: calls },
        { role: 'tool', content: calls.map(call => ({
            type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value: text }
        })) }
    ]
}

/** 提供方异常正文可能包含请求信息；保留类型与错误码供定位。 */
function modelFailure(error: unknown): string {
    if (!(error instanceof Error)) return '模型调用失败'
    const name = /^[\w.-]+$/.test(error.name) ? error.name : 'Error'
    const code = 'code' in error ? error.code : undefined
    return typeof code === 'string' && /^[A-Z0-9_-]+$/.test(code) ? `${name}（${code}）` : name
}

/** 结果工具只描述决定，不执行发布；网络和结构化结果错误共用七次预算。 */
export async function decideDigest(ctx: Context, model: string, prompts: { systemPrompt: string; inputPrompt: string },
    signal: AbortSignal, debug: boolean, wait: (ms: number, signal: AbortSignal) => Promise<void> =
        (ms, signal) => delay(ms, undefined, { signal })): Promise<Decision> {
    const task: ChatSpecMessage = { role: 'user', content: [{ type: 'text', text: prompts.inputPrompt }] }
    let feedback: ChatSpecMessage[] = []
    let lastReason = '模型调用失败'
    for (let attempt = 1; attempt <= 7; attempt++) {
        signal.throwIfAborted()
        try {
            const messages = [task, ...feedback]
            if (debug) ctx.logger.info('每日总结：model.prompt（%s，第 %d 次）\n%s', model, attempt, JSON.stringify({ system: prompts.systemPrompt, messages }))
            const run = ctx.chatluna.chat({ model, system: prompts.systemPrompt, messages,
                toolSpecs: [decisionTool], toolChoice: 'required', purpose: 'livingdiary.digest', cache: false })
            const abort = () => run.abort()
            signal.addEventListener('abort', abort, { once: true })
            try {
                const result = await run
                signal.throwIfAborted()
                if (debug) ctx.logger.info('每日总结：model.response（%s，第 %d 次）\n%s', model, attempt, JSON.stringify(result.content))
                try { return decisionOf(result.toolCalls) }
                catch (error) {
                    lastReason = (error as Error).message
                    feedback = correction(result.toolCalls, lastReason)
                }
            } finally {
                signal.removeEventListener('abort', abort)
            }
        } catch (error) {
            signal.throwIfAborted()
            lastReason = modelFailure(error)
            if (debug) ctx.logger.warn('每日总结：model.failed（%s，第 %d 次）：%s', model, attempt, lastReason)
        }
        if (attempt < 7) await wait(5000, signal)
    }
    throw new Error(`模型生成失败（共尝试 7 次）：${lastReason}`)
}
