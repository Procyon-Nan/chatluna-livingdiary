import { Worker } from 'node:worker_threads'

interface Preview {
    bytes?: Uint8Array
    frames?: { sampled: number; total: number }
    error?: string
}

/** 复用 ChatLuna 的动画预览：等距取至多四帧（含首尾），拼成单张 JPEG。 */
export async function previewGif(buffer: Buffer, signal: AbortSignal) {
    signal.throwIfAborted()
    const worker = new Worker(new URL(import.meta.resolve('@chatluna/transform-image/worker')), { execArgv: [] })
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const { promise, resolve, reject } = Promise.withResolvers<Preview>()
    const abort = () => reject(deadline.reason)
    deadline.addEventListener('abort', abort, { once: true })
    try {
        worker.once('message', resolve)
        worker.once('error', reject)
        worker.once('exit', () => reject(new Error('动画预览工作线程已退出。')))
        worker.postMessage({ id: 1, buffer, frames: 4, portable: false,
            options: { maxSide: 1024, minBytes: 0, quality: 80 } })
        const preview = await promise
        if (!preview.bytes) throw new Error('动画预览生成失败。')
        return { bytes: Buffer.from(preview.bytes), frames: preview.frames }
    } finally {
        deadline.removeEventListener('abort', abort)
        await worker.terminate()
    }
}
