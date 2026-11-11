import type { Context } from 'cordis'
import type { PresetRecord } from '@chatluna/preset'
import type {} from '@chatluna/prompt'

/** 取预设自己声明的系统段，用框架变量环境渲染；不混入宿主全局提示或聊天记录。 */
export async function renderPersona(ctx: Context, preset: PresetRecord, now: Date) {
    const env = await ctx.prompt.environmentOf({ now: +now, presetId: preset.id, botName: preset.name })
    const blocks = (ctx.presets.blocks(preset) ?? [])
        .filter(block => block.zone === 'system' && (block.role ?? 'system') === 'system')
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const complete = blocks.filter(block => block.complete)
    if (complete.length > 1) throw new Error('预设只能有一个完整系统段。')
    const paragraphs: string[] = []
    for (const block of complete.length ? complete : blocks) {
        const raw = typeof block.content === 'string' ? block.content : await block.content({ env })
        let text = raw
        if (block.template) {
            const rendered = await ctx.prompt.render(raw, { zone: 'system', env })
            if (rendered.diagnostics.length) throw new Error(`无法渲染预设段落 ${block.id}：${rendered.diagnostics[0].message}`)
            text = rendered.text
        }
        if (text.trim()) paragraphs.push(text.trim())
    }
    return paragraphs.join('\n\n')
}
