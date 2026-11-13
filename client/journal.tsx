import * as React from 'react'
import { Alert, Badge, EmptyState, Skeleton } from '@chatluna/ui-kit'
import { useLive, useLocale, useTranslate } from '@chatluna/ui-client/client'
import { useDiaryTimeline } from './diary-timeline.ts'
import { DIARY_PAGE_SIZE } from '../src/journal/webui.ts'
import './journal.css'

type Preset = { id: string; name: string }

export function Journal({ preset, presets, onSelect }: { preset: Preset; presets: Preset[]; onSelect(id: string): void }) {
    const t = useTranslate('livingdiary')
    const dates = useLive('livingdiary.dates', { presetId: preset.id })
    const { active } = useLocale()
    const pages = React.useMemo(() => ['presets', ...(dates.data?.length ? dates.data : ['empty'])], [dates.data])
    const { book, rail, stage, position, goTo, sync, touchStart, touchEnd } = useDiaryTimeline(pages, 1)
    const dayFormat = new Intl.DateTimeFormat(active, { month: 'short', day: 'numeric', timeZone: 'UTC' })
    const first = Math.max(0, position.current - 1)
    const touch = React.useRef<{ x: number; y: number; offset: number; dragging: boolean } | null>(null)
    return (
        <div className="ld-book-layout" ref={book} tabIndex={0} aria-label={t('tab.journal')}
            onKeyDown={event => {
                if (event.altKey || event.ctrlKey || event.metaKey) return
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const index = position.current + (event.key === 'ArrowLeft' ? -1 : 1)
                const day = pages[index]
                if (day) goTo(index)
                if (day && rail.current?.contains(event.target as Node)) {
                    rail.current.querySelector<HTMLElement>(`[data-date="${day}"]`)?.focus({ preventScroll: true })
                }
            }}>
            <div className="ld-tab-anchor">
                <button type="button" className="ld-preset-note" onClick={() => goTo(0)}>
                    <span>{t('journal.presetsTab')}</span>
                </button>
            </div>
            <div className="ld-stage" ref={stage}
                onTouchStart={event => {
                    touchStart()
                    const finger = event.touches[0]
                    touch.current = finger && event.touches.length === 1
                        ? { x: finger.clientX, y: finger.clientY, offset: rail.current!.scrollLeft, dragging: false } : null
                }}
                onTouchMove={event => {
                    const finger = event.touches[0], start = touch.current
                    if (!start || !finger || event.touches.length !== 1) return
                    const dx = finger.clientX - start.x
                    if (!start.dragging && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(finger.clientY - start.y)) start.dragging = true
                    if (start.dragging)
                        rail.current!.scrollLeft = start.offset - dx
                }}
                onTouchEnd={() => { touch.current = null; touchEnd() }} onTouchCancel={() => { touch.current = null; touchEnd() }}>
                {pages.slice(first, position.current + 2).map((day, i) => {
                    const index = first + i
                    const side = index === position.left ? 'front' : 'back'
                    return <div key={day} className="ld-layer" data-side={side} data-current={index === position.current}
                        hidden={index < position.left || index > position.left + 1}
                        inert={index !== position.current}>
                        {day === 'presets' && <PresetIndex presets={presets} current={preset} dates={dates.data} onPick={id => {
                            if (id === preset.id) goTo(1)
                            else onSelect(id)
                        }} />}
                        {day === 'empty' && <div className="ld-spread">
                            <section className="ld-leaf ld-story"><h2 className="ld-index-title">{preset.name}</h2></section>
                            <section className="ld-leaf ld-scraps">
                                {dates.error && <Alert variant="destructive">{dates.error}</Alert>}
                                {!dates.error && !dates.data && <Skeleton className="h-12 w-full" />}
                                {!dates.error && dates.data && <EmptyState title={t('journal.empty')} />}
                            </section>
                        </div>}
                        {day !== 'presets' && day !== 'empty' && <Day presetId={preset.id} date={day} />}
                    </div>
                })}
            </div>
            <div className="ld-dock">
                <nav className="ld-rail" aria-label={t('journal.date')} ref={rail} onScroll={sync} onTouchStart={touchStart} onTouchEnd={touchEnd} onTouchCancel={touchEnd}>
                    {pages.map((day, index) => {
                        let label: string
                        if (day === 'presets') label = t('journal.presetsTab')
                        else if (day === 'empty') label = t('tab.journal')
                        else label = dayFormat.format(new Date(day))
                        const title = day === 'presets' || day === 'empty' ? label : day
                        return <button key={day} type="button" data-date={day} title={title} aria-label={title}
                            tabIndex={position.current === index ? 0 : -1} aria-current={position.current === index ? 'page' : undefined} onClick={() => goTo(index)}>
                            <span>{label}</span>
                        </button>
                    })}
                </nav>
            </div>
        </div>
    )
}

function PresetIndex({ presets, current, dates, onPick }: { presets: Preset[]; current: Preset; dates: string[] | undefined; onPick(id: string): void }) {
    const t = useTranslate('livingdiary')
    const { active } = useLocale()
    let inscription: string | undefined
    if (dates?.length) {
        const start = new Date(dates[dates.length - 1]!).toLocaleDateString(active, {
            year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
        })
        inscription = t('journal.bookHistory', { date: start, count: dates.length })
    } else if (dates) {
        inscription = t('journal.firstPage')
    }
    return <article className="ld-spread">
        <section className="ld-leaf ld-story ld-frontispiece">
            <div className="ld-bookplate">
                <p className="ld-bookplate-caption">{t('journal.belongsTo')}</p>
                <div className="ld-signature">
                    <h2>{current.name}</h2>
                    <span className="ld-flower-stamp" aria-hidden="true"><Flower /></span>
                </div>
                {inscription && <p className="ld-inscription">{inscription}</p>}
            </div>
        </section>
        <section className="ld-leaf ld-scraps">
            <header className="ld-scrap-title"><h3>{t('journal.preset')}</h3></header>
            <div className="ld-writing"><ul className="ld-index-list">
                {presets.map(item => <li key={item.id}>
                    <button type="button" onClick={() => onPick(item.id)} aria-current={item.id === current.id ? 'true' : undefined}>
                        <span>{item.name}</span><span aria-hidden="true">›</span>
                    </button>
                </li>)}
            </ul></div>
        </section>
    </article>
}

function Day({ presetId, date }: { presetId: string; date: string }) {
    const t = useTranslate('livingdiary')
    const { active } = useLocale()
    const [entryIndex, setEntryIndex] = React.useState(0)
    const page = Math.floor(entryIndex / DIARY_PAGE_SIZE) + 1
    const result = useLive('livingdiary.entries', { presetId, date, page })
    if (result.error) return <Alert variant="destructive">{result.error}</Alert>
    if (!result.data) return <div className="ld-spread" aria-busy="true"><div className="ld-leaf ld-story" /><div className="ld-leaf ld-scraps" /></div>
    const { entries, total } = result.data
    const entry = entries[entryIndex % DIARY_PAGE_SIZE]
    if (!entry) return <EmptyState title={t('journal.emptyDay')} />
    const day = new Date(date)
    return (
        <article key={entry.id} className="ld-spread">
            <section className="ld-leaf ld-story" aria-label={t('tab.journal')}>
                <header className="ld-dateline">
                    <h2><time dateTime={date}>{day.toLocaleDateString(active, { month: 'long', day: 'numeric', timeZone: 'UTC' })}</time></h2>
                    <div><span>{date.slice(0, 4)}</span><span>{day.toLocaleDateString(active, { weekday: 'long', timeZone: 'UTC' })}</span></div>
                </header>
                <div className="ld-writing ld-prose" tabIndex={0}><p>{entry.content}</p></div>
                <footer className="ld-colophon">
                    <time dateTime={entry.writtenAt}>{new Date(entry.writtenAt).toLocaleTimeString(active, { hour: '2-digit', minute: '2-digit' })}</time>
                    {entry.status && <Badge variant={entry.status === 'failed' ? 'destructive' : 'secondary'}>{t(`status.${entry.status}`)}</Badge>}
                </footer>
            </section>
            <section className="ld-leaf ld-scraps">
                <header className="ld-scrap-title">
                    <span aria-hidden="true" className="ld-tape" />
                    <h3>{t('journal.memoryTitle')}</h3><span className="ld-count">{entry.memoryCount}</span>
                </header>
                <div className="ld-writing" tabIndex={0}>
                    {entry.memoryCount ? <Memories presetId={presetId} id={entry.id} /> : <p className="ld-empty">{t('journal.noMemories')}</p>}
                </div>
                <footer className="ld-colophon"><Flower />
                    {total > 1 && <nav aria-label={t('journal.pages')} className="ld-folios">
                        <button aria-label={t('journal.previousEntry')} disabled={entryIndex === 0} onClick={() => setEntryIndex(entryIndex - 1)}>‹</button>
                        <span>{entryIndex + 1} / {total}</span>
                        <button aria-label={t('journal.nextEntry')} disabled={entryIndex + 1 === total} onClick={() => setEntryIndex(entryIndex + 1)}>›</button>
                    </nav>}
                </footer>
            </section>
        </article>
    )
}

function Flower() {
    return <svg className="ld-flower" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        {[0, 72, 144, 216, 288].map(angle => <ellipse key={angle} cx="12" cy="6.5" rx="3.3" ry="5"
            fill="currentColor" transform={`rotate(${angle} 12 12)`} />)}
        <circle cx="12" cy="12" r="3.2" fill="#ffe39a" />
    </svg>
}

function Memories({ presetId, id }: { presetId: string; id: string }) {
    const result = useLive('livingdiary.memories', { presetId, id })
    if (result.error) return <Alert variant="destructive">{result.error}</Alert>
    if (!result.data) return <Skeleton className="mt-3 h-12 w-full" />
    return <ol className="ld-notes">
        {result.data.map((memory, index) => <li key={memory.id}><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><p>{memory.content}</p></li>)}
    </ol>
}
