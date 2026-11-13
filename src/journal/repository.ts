import { randomUUID } from 'node:crypto'
import { $ } from '@cordisjs/plugin-database'
import type { Context } from 'cordis'
import { DIARY_PAGE_SIZE, type DiaryEntryView, type DiaryMemory, type DiaryPage, type DiaryStatus } from './webui.js'

interface DiaryRow extends DiaryEntryView {
    status: DiaryStatus
    presetId: string
    presetName: string
    memories: DiaryMemory[]
}

declare module '@cordisjs/plugin-database' {
    interface Tables {
        living_diary_entry: DiaryRow
    }
}

const table = 'living_diary_entry'

export function createDiaryJournal(ctx: Context) {
    ctx.model.extend(table, {
        id: 'string(36)',
        presetId: 'string(255)',
        presetName: 'text',
        date: 'string(10)',
        writtenAt: 'string(24)',
        content: 'text',
        status: 'string(16)',
        memoryCount: 'unsigned',
        memories: { type: 'json', initial: [] }
    }, { primary: 'id', indexes: [['presetId', 'writtenAt'], ['presetId', 'date', 'writtenAt']] })

    const db = ctx.database
    const publishing = new Set<string>()
    return {
        async save(entry: Pick<DiaryRow, 'presetId' | 'presetName' | 'content' | 'memories'>, startedAt: Date) {
            const date = [startedAt.getFullYear(), startedAt.getMonth() + 1, startedAt.getDate()]
                .map(part => String(part).padStart(2, '0')).join('-')
            const id = randomUUID()
            await db.create(table, { ...entry, id, date, writtenAt: startedAt.toISOString(),
                status: 'unconfirmed', memoryCount: entry.memories.length })
            ctx.emit('livingdiary/journal-change')
            return id
        },

        async beginPublication(id: string) {
            // 进程中断后这次尝试按失败处理；进行中暂不展示最终结果。
            await db.set(table, { id }, { status: 'failed' })
            publishing.add(id)
            ctx.emit('livingdiary/journal-change')
        },

        async finishPublication(id: string, verified: boolean) {
            try {
                if (verified) await db.set(table, { id }, { status: 'published' })
            } finally {
                publishing.delete(id)
                ctx.emit('livingdiary/journal-change')
            }
        },

        async listPresets() {
            // 预设改名后沿用同一 ID；展示最近一篇日记记录的名称。
            const rows = await db.select(table).groupBy(['presetId', 'presetName'], {
                latest: row => $.max(row.writtenAt)
            }).orderBy('latest', 'desc').orderBy('presetId').execute()
            const names = new Map<string, string>()
            for (const { presetId, presetName } of rows) {
                if (!names.has(presetId)) names.set(presetId, presetName)
            }
            return Array.from(names, ([id, name]) => ({ id, name }))
        },

        async listDates(presetId: string) {
            const rows = await db.select(table, { presetId }).groupBy('date').orderBy('date', 'desc').execute()
            return rows.map(row => row.date)
        },

        async listEntries(presetId: string, date: string, page: number): Promise<DiaryPage> {
            const filter = { presetId, date }
            const [entries, total] = await Promise.all([
                db.select(table, filter).orderBy('writtenAt', 'desc').orderBy('id', 'desc')
                    .limit((page - 1) * DIARY_PAGE_SIZE, DIARY_PAGE_SIZE)
                    .execute(['id', 'date', 'writtenAt', 'content', 'status', 'memoryCount']),
                db.eval(table, row => $.count(row.id), filter)
            ])
            return { entries: entries.map(entry => publishing.has(entry.id) ? { ...entry, status: null } : entry), total }
        },

        async listMemories(presetId: string, id: string): Promise<DiaryMemory[]> {
            const [entry] = await db.get(table, { presetId, id }, ['memories'])
            return entry?.memories ?? []
        }
    }
}

export type DiaryJournal = ReturnType<typeof createDiaryJournal>
