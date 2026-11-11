import type { Context } from 'cordis'
import type {} from '@chatluna/storage-files'
import type { PublishImageInput } from 'qzone-sdk'

import { checkImageSize, downloadImageBytes, ImageReadError } from '../image.js'

const maxImageBytes = 32 * 1024 * 1024

function imageName(pathname: string): string {
    let name = pathname.split('/').pop() ?? ''
    try {
        name = decodeURIComponent(name)
    } catch {
        // 非编码的百分号按原始文件名处理。
    }
    return name.replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 80) || 'image.jpg'
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
        checkImageSize(data.byteLength, maxImageBytes)
        return { data, name: file.name }
    }
    const url = URL.parse(reference)
    if (url?.protocol !== 'https:' && url?.protocol !== 'http:') {
        throw new ImageReadError('请提供对话中的图片或 HTTP(S) 图片地址。')
    }
    return { data: await downloadImageBytes(url, maxImageBytes, signal), name: imageName(url.pathname) }
}
