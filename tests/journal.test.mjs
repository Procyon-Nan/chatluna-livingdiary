import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { createDiaryJournal } from '../lib/journal/repository.js'

test('日记和参考记忆跨重启保留；按预设和日期分页，改名、同日多篇和中断结果可区分', async t => {
    await mkdir('tmp', { recursive: true })
    const folder = await mkdtemp(join('tmp', 'journal-'))
    t.after(() => rm(folder, { recursive: true, force: true }))
    async function open() {
        const ctx = new Context()
        ctx.baseUrl = pathToFileURL(join(folder, 'instance.yml')).href
        await ctx.plugin(Database)
        await ctx.plugin(SQLiteDriver, { path: 'journal.db' })
        const journal = createDiaryJournal(ctx)
        await ctx.database.prepared()
        return { ctx, journal }
    }
    const first = await open()
    const entry = { presetId: 'a', presetName: '旧名', content: '日记', memories: [{ id: '42', content: '原始记忆' }] }
    let savedId
    try {
        const writtenAt = new Date(2026, 10, 13, 0, 2)
        savedId = await first.journal.save(entry, writtenAt)
        await first.journal.beginPublication(savedId)
        // 在途不能提前显示失败；模拟发布过程中重启，重新打开后按失败处理。
        assert.equal((await first.journal.listEntries('a', '2026-11-13', 1)).entries[0].status, null)
        entry.memories[0].content = '后来修改'
        for (let i = 0; i < 11; i++) {
            await first.journal.save({ ...entry, presetName: '新名', content: `第 ${i} 篇` }, new Date(+writtenAt + (i + 1) * 60000))
        }
        await first.journal.save(entry, new Date(2026, 10, 12, 23, 59))
        await first.journal.save({ ...entry, presetId: 'b', presetName: '另一个预设' }, writtenAt)
    } finally {
        await first.ctx.fiber.dispose()
    }
    const { ctx, journal } = await open()
    try {
        assert.deepEqual(await journal.listPresets(), [{ id: 'a', name: '新名' }, { id: 'b', name: '另一个预设' }])
        const page = await journal.listEntries('a', '2026-11-13', 1)
        assert.equal(page.total, 12)
        assert.equal(page.entries.length, 10)
        assert.equal(page.entries[0].content, '第 10 篇')
        assert.equal(page.entries[0].status, 'unconfirmed')
        const last = (await journal.listEntries('a', '2026-11-13', 2)).entries.at(-1)
        assert.deepEqual(last, { id: savedId, content: '日记', date: '2026-11-13', writtenAt: new Date(2026, 10, 13, 0, 2).toISOString(),
            status: 'failed', memoryCount: 1 })
        assert.deepEqual(await journal.listMemories('a', savedId), [{ id: '42', content: '原始记忆' }])
        assert.deepEqual(await journal.listMemories('b', savedId), [])
        assert.deepEqual(await journal.listDates('a'), ['2026-11-13', '2026-11-12'])
        assert.equal((await journal.listEntries('a', '2026-11-12', 1)).total, 1)
        await journal.beginPublication(page.entries[0].id)
        await journal.finishPublication(page.entries[0].id, true)
        assert.equal((await journal.listEntries('a', '2026-11-13', 1)).entries[0].status, 'published')
    } finally {
        await ctx.fiber.dispose()
    }
})
