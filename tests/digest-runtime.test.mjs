import assert from 'node:assert/strict'
import test from 'node:test'
import { DailyDigestRuntime, nextDigestDelay } from '../lib/daily-digest/runtime.js'

test('定时时刻按本地日历计算，已到点则从次日开始，跨年后恢复到配置的时分', () => {
    const at = { hour: 0, minute: 2 }
    const before = new Date(2026, 11, 31, 23, 59, 58)
    assert.equal(nextDigestDelay(at, before), 122000)
    const exact = new Date(2027, 0, 1, 0, 2)
    assert.equal(exact.getTime() + nextDigestDelay(at, exact), new Date(2027, 0, 2, 0, 2).getTime())
})

test('手动执行跨过定时时刻不重复处理，次日能再次定时，进行中拒绝手动触发', async t => {
    const start = new Date(2026, 11, 31, 23, 58)
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start })
    const reports = { digest: null }
    const runs = []
    const runtime = new DailyDigestRuntime(async (trigger, _signal, time) => {
        const gate = Promise.withResolvers()
        runs.push({ trigger, time, gate })
        await gate.promise
        return { trigger, triggeredAt: time.toISOString(), result: 'skipped-empty', detail: '当日无记忆' }
    }, reports, { info() {}, error: assert.fail })
    runtime.schedule({ hour: 23, minute: 59 })
    const manual = runtime.run('manual')
    t.mock.timers.tick(60_000)
    assert.deepEqual(runs.map(run => run.trigger), ['manual'])
    runs[0].gate.resolve()
    assert.equal(await manual, reports.digest)
    const tomorrow = new Date(2027, 0, 1, 23, 59)
    t.mock.timers.tick(tomorrow.getTime() - Date.now())
    assert.deepEqual(runs.map(run => run.trigger), ['manual', 'scheduled'])
    assert.equal(runs[1].time.getTime(), tomorrow.getTime())
    assert.equal(runtime.run('manual'), undefined)
    runs[1].gate.resolve()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reports.digest.trigger, 'scheduled')
    await runtime.stop()
    assert.equal(reports.digest.trigger, 'scheduled')
    t.mock.timers.tick(86_400_000)
    assert.equal(runs.length, 2)
})

test('卸载会等待在途任务；已发布的结果仍返回给发起方，不覆盖旧报告', async () => {
    const gate = Promise.withResolvers()
    const previous = { trigger: 'manual', triggeredAt: '2026-11-10T15:00:00.000Z', result: 'skipped-by-model', detail: '' }
    const reports = { digest: previous }
    let signal
    const runtime = new DailyDigestRuntime(async (trigger, cancellation, startedAt) => {
        signal = cancellation
        await gate.promise
        return { trigger, triggeredAt: startedAt.toISOString(), result: 'published', detail: '' }
    }, reports, { info() {}, error: assert.fail })
    const task = runtime.run('manual')
    let stopped = false
    const stopping = runtime.stop().then(() => { stopped = true })
    await Promise.resolve()
    assert.equal(signal.aborted, true)
    assert.equal(stopped, false)
    assert.throws(() => runtime.run('manual'), { name: 'AbortError' })
    gate.resolve()
    assert.equal((await task).result, 'published')
    await stopping
    assert.equal(reports.digest, previous)
})

test('关闭定时后仍可手动写日记；先验证发起人，空记忆不调用模型或发布', async () => {
    const { registerDailyDigest } = await import('../lib/daily-digest/index.js')
    const config = { allowUserIds: ['123'], personaPresetId: 'p', mainModel: '@small', digestMemoryLimit: 50, enableDailyDigest: false }
    const reports = { digest: null }
    let action, stop, reads = 0
    const ctx = {
        logger: { info() {}, warn: assert.fail, error: assert.fail },
        presets: { get: id => ({ id, status: 'ready' }) },
        get(name) {
            assert.equal(name, 'livingmemory')
            return { repository: { async listEntriesByPreset(id) { assert.equal(id, 'p'); reads++; return [] } } }
        },
        effect(fn) { stop = fn() },
        plugin(child) { child.apply(this) },
        command(name, _description, options) {
            assert.equal(name, 'qzone.digest')
            assert.equal(options.owner, 'livingdiary')
            return { action(fn) { action = fn } }
        }
    }
    registerDailyDigest(ctx, config, { publish: assert.fail }, reports)
    assert.match(await action({ session: { platform: 'discord', userId: '123' } }), /未授权/)
    assert.equal(reads, 0)
    assert.match(await action({ session: { platform: 'onebot', userId: '123' } }), /当日无记忆/)
    assert.equal(reads, 1)
    assert.equal(reports.digest.trigger, 'manual')
    assert.equal(reports.digest.result, 'skipped-empty')
    await stop()
})
