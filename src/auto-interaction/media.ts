import type { Context } from 'cordis'
import type {} from '@chatluna/ai-runtime'
import type { ChatBlock, ChatFileBlock } from '@chatluna/ai'
import type {} from '@chatluna/storage-files'
import type { QzoneMedia } from 'qzone-sdk'
import { downloadImageBytes, ImageReadError, type ImageReadPolicy } from '../image.js'
import { callModel } from '../model.js'
import { previewGif } from './gif.js'

const maxImageBytes = 15 * 1024 * 1024
const maxTotalBytes = 45 * 1024 * 1024
const visionRole = '@vision'

export interface PreparedInteractionMedia {
    lines: string[]
    imageParts: ChatFileBlock[]
    readable: ReadonlySet<string>
    read(ids: string[]): Promise<ChatBlock[]>
}

function metadata(media: QzoneMedia, id: string) {
    const fields = [`media_id=${id}`, `kind=${media.kind}`]
    if (media.name) fields.push(`name=${media.name}`)
    if (media.mimeType) fields.push(`declared_mime=${media.mimeType}`)
    if (media.size !== undefined) fields.push(`size=${media.size}`)
    if ('width' in media && media.width !== undefined) fields.push(`width=${media.width}`)
    if ('height' in media && media.height !== undefined) fields.push(`height=${media.height}`)
    if ('durationMs' in media && media.durationMs !== undefined) fields.push(`durationMs=${media.durationMs}`)
    return fields.join(' ')
}

function isQzoneImageUrl(url: URL) {
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.port) return false
    // QQ 空间照片列表使用 photo.store.qq.com，详情与缩略图使用 qpic.cn。
    return ['qpic.cn', 'photo.store.qq.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))
}

async function download(url: URL, policy: ImageReadPolicy, signal: AbortSignal) {
    const bytes = await downloadImageBytes(url, maxImageBytes, signal, policy)
    const head = bytes.subarray(0, 12)
    let mime: string
    if (head.subarray(0, 3).toString('hex') === 'ffd8ff') mime = 'image/jpeg'
    else if (head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') mime = 'image/png'
    else if (['GIF87a', 'GIF89a'].includes(head.toString('ascii', 0, 6))) mime = 'image/gif'
    else if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp'
    else throw new ImageReadError('图片格式不受支持。')
    return { bytes, mime }
}

async function asFile(ctx: Context, id: string, bytes: Buffer, mime: string, signal: AbortSignal): Promise<ChatFileBlock> {
    const filename = `${id}.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}`
    const file = { type: 'file' as const, filename, mediaType: mime, fileSize: bytes.length }
    const storage = ctx.get('chatluna_storage')
    if (storage) {
        try {
            const stored = await storage.createTempFile(bytes, filename, { mimeType: mime, expireHours: 1 })
            signal.throwIfAborted()
            return { ...file, data: { type: 'reference', reference: `storage://${stored.id}` } }
        } catch {
            signal.throwIfAborted()
        }
    }
    return { ...file, data: { type: 'data', data: bytes.toString('base64') } }
}

type Download = Awaited<ReturnType<typeof download>>

/** 只在当前动态内用 M 编号读取图片；给模型的内容不携带 QQ 下载地址。 */
export async function prepareInteractionMedia(ctx: Context, media: readonly QzoneMedia[], model: string,
    signal: AbortSignal): Promise<PreparedInteractionMedia> {
    signal.throwIfAborted()
    const imageParts: ChatFileBlock[] = []
    const lines: string[] = []
    const readers = new Map<string, () => Promise<ChatBlock[]>>()
    let imageCount = 0
    const policy = { remainingBytes: maxTotalBytes, allowUrl: isQzoneImageUrl }
    let direct = false
    let vision = false
    if (media.some(item => item.kind === 'image')) {
        direct = (await ctx.ai.caps<'chat'>(model, signal)).image === true
        if (!direct) {
            try {
                vision = (await ctx.ai.caps<'chat'>(visionRole, signal)).image === true
            } catch {
                signal.throwIfAborted()
            }
        }
    }
    for (const [index, item] of media.entries()) {
        signal.throwIfAborted()
        const id = `M${index + 1}`
        const description = metadata(item, id)
        if (item.kind !== 'image') {
            lines.push(`${description} status=metadata-only`)
            continue
        }
        if (++imageCount > 9) {
            lines.push(`${description} status=unresolved:image-count-limit`)
            continue
        }
        if (!direct && !vision) {
            lines.push(`${description} status=unresolved:no-image-reader`)
            continue
        }

        const url = URL.parse(item.url)
        if (!url || !isQzoneImageUrl(url)) {
            lines.push(`${description} status=unresolved:unsupported-image-host`)
            continue
        }
        const load = () => download(url, policy, signal)
        let downloaded: Download | undefined
        if (direct) {
            try {
                downloaded = await load()
                if (downloaded.mime !== 'image/gif') {
                    imageParts.push(await asFile(ctx, id, downloaded.bytes, downloaded.mime, signal))
                    lines.push(`${description} actual_mime=${downloaded.mime} status=attached`)
                    continue
                }
            } catch (error) {
                signal.throwIfAborted()
                lines.push(`${description} status=unresolved:${mediaError(error)}`)
                continue
            }
        }

        lines.push(`${description} status=tool-readable`)
        readers.set(id, async () => {
            const image = downloaded ?? await load()
            const gif = image.mime === 'image/gif' ? await previewGif(image.bytes, signal) : undefined
            const file = await asFile(ctx, id, gif?.bytes ?? image.bytes, gif ? 'image/jpeg' : image.mime, signal)
            const frames = gif?.frames
            const label = frames ? `${id}：按阅读顺序展示 ${frames.sampled}/${frames.total} 帧。` : id
            const parts: ChatBlock[] = [{ type: 'text', text: label }, file]
            if (direct) return parts
            const result = await callModel(ctx, { model: visionRole, purpose: 'livingdiary.interaction.media', cache: false,
                system: '说明图片中可见的内容和文字。若为动画拼图，按阅读顺序说明画面变化。只描述观察到的内容。',
                messages: [{ role: 'user', content: parts }] }, signal)
            if (!result.text.trim()) throw new ImageReadError('读图模型没有返回描述。')
            return [{ type: 'text', text: `${id}：${result.text.trim()}` }]
        })
    }
    const cache = new Map<string, ChatBlock[]>()
    async function read(ids: string[]) {
        const parts: ChatBlock[] = []
        for (const id of ids) {
            signal.throwIfAborted()
            let result = cache.get(id)
            if (!result) {
                try {
                    result = await readers.get(id)!()
                } catch (error) {
                    signal.throwIfAborted()
                    result = [{ type: 'text', text: `${id}：读取失败，${mediaError(error)}请按未解析处理。` }]
                }
                cache.set(id, result)
            }
            parts.push(...result)
        }
        return parts
    }
    return { lines, imageParts, readable: new Set(readers.keys()), read }
}

function mediaError(error: unknown) {
    return error instanceof ImageReadError ? error.message : '图片无法解析。'
}
