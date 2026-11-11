import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareInteractionMedia } from '../lib/auto-interaction/media.js'

const png = Buffer.from('89504e470d0a1a0a', 'hex')
function read(urls) {
    const ctx = { ai: { caps: async () => ({ image: true }) }, get: () => undefined }
    return prepareInteractionMedia(ctx, urls.map(url => ({ kind: 'image', url })), '@small', new AbortController().signal)
}

test('空间图片可由旧列表域名跳转到详情 CDN；每次请求都由插件检查目标地址', async t => {
    const visited = []
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(options.redirect, 'manual')
        visited.push(url.href)
        if (url.hostname === 'photo.store.qq.com') return Response.redirect('https://m.qpic.cn/psc123')
        if (url.pathname === '/psc123') return new Response(null, { status: 307, headers: { location: '/actual.png' } })
        return new Response(png)
    })
    const result = await read(['http://photo.store.qq.com/psc'])
    assert.deepEqual(visited, ['http://photo.store.qq.com/psc', 'https://m.qpic.cn/psc123', 'https://m.qpic.cn/actual.png'])
    assert.equal(result.imageParts.length, 1)
})

test('拒绝内网、仿冒域、带账号或自选端口的 URL；CDN 返回的重定向也不能访问本机', async t => {
    const visited = []
    t.mock.method(globalThis, 'fetch', async url => {
        visited.push(url.href)
        return Response.redirect('http://127.0.0.1/private.png')
    })
    const result = await read(['http://127.0.0.1/p', 'http://[::1]/p', 'http://localhost/p', 'http://169.254.169.254/p',
        'https://qpic.cn.evil.test/p', 'https://m.qpic.cn@evil.test/p', 'https://name@m.qpic.cn/p', 'https://m.qpic.cn:8000/p',
        'https://m.qpic.cn/redirect'])
    assert.deepEqual(visited, ['https://m.qpic.cn/redirect'])
    assert.equal(result.imageParts.length, 0)
    assert.equal(result.readable.size, 0)
    assert.ok(result.lines.every(s => s.includes('unresolved')))
})

test('图片格式无效和响应中断也消耗 45 MiB 总预算，达到上限不再发起下载', async t => {
    let requests = 0
    const chunk = new Uint8Array(1024 * 1024)
    t.mock.method(globalThis, 'fetch', async () => {
        const interrupted = ++requests === 1
        let bytes = 0
        return new Response(new ReadableStream({
            pull(controller) {
                if (bytes < 9) { bytes++; controller.enqueue(chunk); return }
                if (interrupted) controller.error(Error('连接中断'))
                else controller.close()
            }
        }, { highWaterMark: 0 }))
    })
    const result = await read(Array.from({ length: 9 }, (_, i) => 'https://m.qpic.cn/' + i))
    assert.equal(requests, 5)
    assert.equal(result.imageParts.length, 0)
    assert.match(result.lines[0], /网络错误/)
    assert.match(result.lines[1], /图片格式不受支持/)
    assert.ok(result.lines.slice(5).every(line => line.includes('总大小超过')))
})
