import type { Context } from 'cordis'
import { existsSync, watch } from 'node:fs'
import { Schema } from '@chatluna/schema'
import type {} from '@chatluna/ui-server'
import type {} from '@cordisjs/plugin-loader'
import type { DiaryJournal } from './journal/repository.js'
import type {} from './journal/webui.js'

export function registerWebUI(ctx: Context, owner: Context, journal: DiaryJournal, configuredPreset: string) {
    const ui = ctx.chatluna_webui
    const files = { baseUrl: import.meta.url, source: '../client/index.ts', bundle: '../dist/client.js' }
    let entry = ui.addEntry(files)
    // 仅源码工作区提供 yarn dev。等整次构建写完，再通知已打开的 WebUI 换用新文件。
    if (!ui.config.devMode && existsSync(new URL('../scripts/build-client.mjs', import.meta.url))) {
        ctx.effect(() => {
            const watcher = watch(new URL('../', import.meta.url), (_event, file) => {
                if (file !== '.webui-reload') return
                const previous = entry
                entry = ui.addEntry(files)
                previous.dispose()
            })
            return () => watcher.close()
        })
    }
    ui.state('livingdiary.settingsEntry', {
        get: () => {
            const entry = owner.fiber.entry
            return entry ? { id: entry.id, name: entry.options.name } : null
        }
    })
    ui.state('livingdiary.presets', {
        refreshOn: ['livingdiary/journal-change', 'presets/change'],
        get: async () => {
            const history = await journal.listPresets()
            if (!configuredPreset) return history
            const name = ctx.presets.get(configuredPreset)?.name
                ?? history.find(preset => preset.id === configuredPreset)?.name ?? configuredPreset
            return [{ id: configuredPreset, name }, ...history.filter(preset => preset.id !== configuredPreset)]
        }
    })
    ui.state('livingdiary.dates', {
        params: Schema.object({ presetId: Schema.string().required() }),
        refreshOn: ['livingdiary/journal-change'],
        get: ({ presetId }) => journal.listDates(presetId)
    })
    ui.state('livingdiary.entries', {
        params: Schema.object({
            presetId: Schema.string().required(),
            date: Schema.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
            page: Schema.natural().min(1).required()
        }),
        refreshOn: ['livingdiary/journal-change'],
        get: ({ presetId, date, page }) => journal.listEntries(presetId, date, page)
    })
    ui.state('livingdiary.memories', {
        params: Schema.object({ presetId: Schema.string().required(), id: Schema.string().required() }),
        get: ({ presetId, id }) => journal.listMemories(presetId, id)
    })
}
