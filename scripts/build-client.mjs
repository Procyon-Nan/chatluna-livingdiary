import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { build } from '@chatluna/ui-client'

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '')
const watch = process.argv.includes('--watch')
await build(root, {
    logLevel: 'info',
    plugins: watch ? [{
        name: 'livingdiary:notify-ui',
        async writeBundle() {
            await writeFile(new URL('../.webui-reload', import.meta.url), String(Date.now()))
        }
    }] : [],
    build: {
        watch: watch ? {} : null,
        rollupOptions: {
            onwarn(warning, warn) {
                // The entire plugin UI already runs in the browser.
                if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) return
                warn(warning)
            }
        }
    }
})
