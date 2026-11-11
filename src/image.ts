export class ImageReadError extends Error {}

export function checkImageSize(size: number, maxBytes: number) {
    if (size === 0) throw new ImageReadError('图片内容为空。')
    if (size > maxBytes) throw new ImageReadError('图片大小超过读取上限。')
}

export interface ImageReadPolicy {
    remainingBytes: number
    allowUrl(url: URL): boolean
}

async function imageResponse(url: URL, signal: AbortSignal, policy?: ImageReadPolicy) {
    const headers = { accept: 'image/*,*/*' }
    if (!policy) return fetch(url, { headers, signal })
    if (policy.remainingBytes <= 0) throw new ImageReadError('动态图片总大小超过读取上限。')
    for (let redirects = 0; redirects <= 5; redirects++) {
        if (!policy.allowUrl(url)) throw new ImageReadError('图片地址不属于受支持的 QQ 空间图片域名。')
        const response = await fetch(url, { headers, signal, redirect: 'manual' })
        if (![301, 302, 303, 307, 308].includes(response.status)) return response
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location) throw new ImageReadError('图片重定向缺少地址。')
        url = new URL(location, url)
    }
    throw new ImageReadError('图片重定向次数超过上限。')
}

export async function downloadImageBytes(url: URL, maxBytes: number, signal?: AbortSignal, policy?: ImageReadPolicy): Promise<Buffer> {
    const timeout = AbortSignal.timeout(30_000)
    try {
        const response = await imageResponse(url, signal ? AbortSignal.any([signal, timeout]) : timeout, policy)
        if (!response.ok || !response.body) {
            await response.body?.cancel()
            if (response.status === 404) throw new ImageReadError('图片地址已过期，请改用较新的地址。')
            throw new ImageReadError(`图片下载失败（HTTP ${response.status}）。`)
        }
        const chunks: Uint8Array[] = []
        let size = 0
        const limit = Math.min(maxBytes, policy?.remainingBytes ?? maxBytes)
        const length = response.headers.get('content-length')
        if (policy && length !== null && Number(length) > limit) {
            await response.body.cancel()
            throw new ImageReadError('图片大小超过读取上限。')
        }
        for await (const chunk of response.body) {
            if (policy) policy.remainingBytes = Math.max(0, policy.remainingBytes - chunk.byteLength)
            size += chunk.byteLength
            checkImageSize(size, limit)
            chunks.push(chunk)
        }
        checkImageSize(size, maxBytes)
        return Buffer.concat(chunks, size)
    } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof ImageReadError) throw error
        // 平台图片 URL 常含访问令牌，不透传底层异常。
        throw new ImageReadError('图片下载失败（网络错误或超时）。')
    }
}
