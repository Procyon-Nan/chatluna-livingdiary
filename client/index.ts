import type { Context } from 'cordis'
import type {} from '../src/journal/webui.ts'
import zh from './locales/zh.yml'
import en from './locales/en.yml'

export default function apply(ctx: Context) {
    ctx.locale.register('livingdiary', { zh, en })
    ctx.slots.route({
        path: '/livingdiary',
        page: async () => (await import('./page.tsx')).LivingDiaryPage,
        title: 'LivingDiary',
        icon: 'book-open-text',
        order: 37,
        group: 'capabilities',
        groupOrder: 37
    })
}
