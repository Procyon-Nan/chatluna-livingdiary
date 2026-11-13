import type {} from '@chatluna/ui-client/client'

export const DIARY_PAGE_SIZE = 10

export type DiaryStatus = 'unconfirmed' | 'published' | 'failed'

export interface DiaryEntryView {
    id: string
    date: string
    writtenAt: string
    content: string
    status: DiaryStatus | null
    memoryCount: number
}

export interface DiaryPage {
    entries: DiaryEntryView[]
    total: number
}

export interface DiaryMemory {
    id: string
    content: string
}

declare module '@chatluna/ui-client/client' {
    interface States {
        'livingdiary.presets': { id: string; name: string }[]
        'livingdiary.entries': DiaryPage
        'livingdiary.dates': string[]
        'livingdiary.memories': DiaryMemory[]
        'livingdiary.settingsEntry': { id: string; name: string } | null
    }
}

declare module 'cordis' {
    interface Events<C = any> {
        'livingdiary/journal-change'(): void
    }
}
