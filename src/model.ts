import type { Context } from 'cordis'
import { ModelError } from '@chatluna/ai'
import type { ChatOptions, ChatResult } from '@chatluna/ai-runtime/ops'
import type {} from '@chatluna/core'

/** 把后台任务的取消信号传给 v2 单步模型调用。 */
export async function callModel(ctx: Context, options: ChatOptions, signal: AbortSignal): Promise<ChatResult> {
    signal.throwIfAborted()
    const run = ctx.chatluna.chat(options)
    const abort = () => run.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
        const result = await run
        signal.throwIfAborted()
        const { finish } = result
        if (finish.kind === 'error' || finish.kind === 'aborted') throw new ModelError(finish.failure)
        if (finish.kind === 'max-tokens') throw new Error('模型输出达到长度上限。')
        if (finish.kind === 'content-filter') throw new Error('模型输出被内容过滤。')
        return result
    } finally {
        signal.removeEventListener('abort', abort)
    }
}
