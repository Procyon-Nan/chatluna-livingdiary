import * as React from 'react'
import { Alert, Button, Skeleton } from '@chatluna/ui-kit'
import { toast, useAction, useLive, useLocale, useTranslate } from '@chatluna/ui-client/client'
import { deepEqual, SchemaForm, useFormValidation } from '@chatluna/ui-schema-form/client'
import type { PluginDocument } from '@chatluna/runtime-webui'

export function Settings() {
    const t = useTranslate('livingdiary')
    const entry = useLive('livingdiary.settingsEntry')
    if (entry.error) return <Alert variant="destructive">{entry.error}</Alert>
    if (entry.data) return <InstanceForm key={entry.data.id} {...entry.data} />
    if (entry.status === 'ready') return <Alert>{t('settings.noEntry')}</Alert>
    return <Skeleton className="h-32 w-full" />
}

function InstanceForm({ id, name }: { id: string; name: string }) {
    const t = useTranslate('livingdiary')
    const locale = useLocale()
    const runtime = useLive('plugins.runtime', { name, locale: locale.active.startsWith('zh') ? 'zh' : 'en' })
    const document = useLive('plugins.document', { id })
    const validation = useFormValidation()
    const [draft, setDraft] = React.useState<{ base: PluginDocument; values: PluginDocument['values'] }>()

    function discard() {
        setDraft(undefined)
        validation.reset()
    }
    const save = useAction('plugins.save', {
        onSuccess: () => {
            discard()
            toast.success(t('settings.saved'))
        }
    })
    const error = runtime.error || document.error || runtime.data?.error
    if (error) return <Alert variant="destructive">{error}</Alert>
    if (!runtime.data || !document.data) return <Skeleton className="h-32 w-full" />
    if (!runtime.data.schema) return <Alert>{t('settings.noSchema')}</Alert>

    const base = draft?.base ?? document.data
    function change(values: PluginDocument['values']) {
        setDraft(deepEqual(values, base.values) ? undefined : { base, values })
    }
    function submit() {
        if (draft && validation.attempt()) void save({ id, config: draft.values, revision: draft.base.revision })
    }
    return (
        <section className="mx-auto w-full max-w-3xl space-y-4">
            <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 bg-background py-2">
                <p className="text-sm text-muted-foreground">{t('settings.scope')}</p>
                <div className="flex gap-2">
                    <Button variant="outline" disabled={!draft || save.pending} onClick={discard}>{t('settings.discard')}</Button>
                    <Button disabled={!draft || save.pending || save.offline} onClick={submit}>{t('settings.save')}</Button>
                </div>
            </div>
            <fieldset disabled={save.pending} className="min-w-0">
                <SchemaForm schema={runtime.data.schema} formId={`plugin:${id}`} initial={base.values}
                    value={draft?.values ?? base.values} credentials={base.credentials} validation={validation} onChange={change} />
            </fieldset>
        </section>
    )
}
