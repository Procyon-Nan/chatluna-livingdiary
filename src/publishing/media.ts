import type { Context } from 'cordis'
import type {} from '@chatluna/storage-files'
import type { PublishImageInput } from 'qzone-sdk'

const maxImageBytes = 32 * 1024 * 1024

export class ImageReadError extends Error {}

function checkSize(size: number) {
    if (size === 0) throw new ImageReadError('图片内容为空。')
    if (size > maxImageBytes) throw new ImageReadError('图片大小超过 32 MB。')
}

function imageName(pathname: string): string {
    let name = pathname.split('/').pop() ?? ''
    try {
        name = decodeURIComponent(name)
    } catch {
        // 非编码的百分号按原始文件名处理。
    }
    return name.replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 80) || 'image.jpg'
}

async function downloadImage(url: URL, signal?: AbortSignal): Promise<PublishImageInput> {
    const timeout = AbortSignal.timeout(30_000)
    try {
        const response = await fetch(url, {
            headers: { accept: 'image/*,*/*' },
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        })
        if (!response.ok || !response.body) {
            await response.body?.cancel()
            if (response.status === 404) throw new ImageReadError('图片地址已过期，请改用较新的地址。')
            throw new ImageReadError(`图片下载失败（HTTP ${response.status}）。`)
        }
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const chunk of response.body) {
            size += chunk.byteLength
            checkSize(size)
            chunks.push(chunk)
        }
        checkSize(size)
        return { data: Buffer.concat(chunks, size), name: imageName(url.pathname) }
    } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof ImageReadError) throw error
        // 平台图片 URL 常含访问令牌，不透传底层异常。
        throw new ImageReadError('图片下载失败（网络错误或超时）。')
    }
}

/** 对话文件用框架返回的 storage://id 或 /files/name；外部链接仅从 HTTP(S) 下载。 */
export async function readPublishImage(ctx: Context, reference: string, signal?: AbortSignal): Promise<PublishImageInput> {
    if (reference.startsWith('storage://') || reference.startsWith('/files/')) {
        const key = reference.startsWith('storage://')
            ? reference.slice('storage://'.length)
            : decodeURIComponent(reference.slice('/files/'.length))
        if (!key) throw new ImageReadError('图片地址缺少文件标识。')
        const file = await ctx.get('chatluna_storage')?.getTempFile(key)
        if (!file) throw new ImageReadError('临时图片不可用，请重新提供图片。')
        const data = await file.data
        checkSize(data.byteLength)
        return { data, name: file.name }
    }
    const url = URL.parse(reference)
    if (url?.protocol !== 'https:' && url?.protocol !== 'http:') {
        throw new ImageReadError('请提供对话中的图片或 HTTP(S) 图片地址。')
    }
    return downloadImage(url, signal)
}
