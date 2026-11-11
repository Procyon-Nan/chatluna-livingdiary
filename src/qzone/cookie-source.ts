import type { Universal, Bot } from '@satorijs/core'

/** 获取 QQ 空间 Cookie 的域名回退顺序（协议通用）。 */
export const COOKIE_DOMAIN_CANDIDATES: readonly string[] = [
    'user.qzone.qq.com',
    'qzone.qq.com',
    'h5.qzone.qq.com',
    'mobile.qzone.qq.com'
]

/** 支持经机器人获取 QQ 空间 Cookie 的协议；数组顺序即自动档的回退优先级。 */
export type CookiePlatform = 'onebot' | 'milky'

export const COOKIE_BOT_PLATFORMS: readonly CookiePlatform[] = [
    'onebot',
    'milky'
]

/** Cookie 机器人协议选择：具体协议，或 auto（按回退优先级自动选择）。 */
export type CookiePlatformSelection = CookiePlatform | 'auto'

/** 可识别 QQ 账号的 Cookie 候选键，按优先级排列。 */
const UIN_CANDIDATE_KEYS: readonly string[] = [
    'uin',
    'p_uin',
    'ptui_loginuin',
    'luin'
]

/** QQ 空间票据 Cookie 键；任一非空即视为具备登录态载体。 */
const QZONE_TICKET_KEYS: readonly string[] = ['p_skey', 'skey', 'skey2']

/** 通过验收的一次 Cookie 获取结果。 */
export interface QzoneCookieGrant {
    /** 原样传递给 qzone-sdk 的 Cookie Header 文本。 */
    readonly cookies: string
    readonly accountId: string
    readonly domain: string
}

/** 没有可用的 OneBot/Milky 机器人（未上线或 platform/selfId 不匹配）。 */
export class NoBotAvailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'NoBotAvailableError'
    }
}

/** 所有候选域名均未取得可用 Cookie。 */
export class CookieAcquireError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CookieAcquireError'
    }
}

/** 解析 Cookie Header 文本为名值对象；仅取每个分号段的名称与首个等号后的值。 */
export function parseCookieHeader(header: string): Record<string, string> {
    const jar: Record<string, string> = {}
    for (const segment of header.split(';')) {
        const index = segment.indexOf('=')
        if (index <= 0) continue
        const name = segment.slice(0, index).trim()
        if (!name) continue
        jar[name] = segment.slice(index + 1).trim()
    }
    return jar
}

/** QQ Cookie 的 uin 可以在账号前补零；Satori 的 selfId 使用平台 QQ 号。 */
export function canonicalQQ(value: string): string {
    return value.replace(/^0+(?=\d)/, '')
}

/** 从 Cookie 名值对象中识别 QQ 账号；无法识别时返回 null。 */
export function extractUin(
    jar: Readonly<Record<string, string>>
): string | null {
    for (const key of UIN_CANDIDATE_KEYS) {
        const raw = jar[key]
        if (!raw) continue
        const cleaned = raw.trim().replace(/^[oO]+/, '')
        if (/^\d+$/.test(cleaned)) return cleaned
    }
    return null
}

/** Cookie 可用判定（验收条件）：具备至少一个 QQ 空间票据。 */
export function hasQzoneTicket(jar: Readonly<Record<string, string>>): boolean {
    return QZONE_TICKET_KEYS.some((key) => Boolean(jar[key]))
}

/** 能提供 QQ 空间 Cookie 的机器人视图（OneBot / Milky 协议中立）。 */
export interface CookieBot {
    readonly platform: CookiePlatform
    readonly selfId: string
    /** 获取指定域名的 Cookie Header 文本。 */
    getCookieHeader(domain: string): Promise<string>
    /** 获取登录账号 QQ 号；协议端不可用时返回 null。 */
    getLoginUin(): Promise<string | null>
}

/** 选择器所需的机器人最小视图。 */
export interface CookieBotView {
    readonly platform?: string
    readonly selfId: string
    readonly status: Universal.Status
}

const ONLINE_STATUS: Universal.Status.ONLINE = 1

const COOKIE_PLATFORM_LABELS: Record<CookiePlatform, string> = {
    onebot: 'OneBot',
    milky: 'Milky'
}

/** 协议标识转展示名（错误文案与状态显示用）；未知值原样返回。 */
export function cookiePlatformLabel(platform: string): string {
    return COOKIE_PLATFORM_LABELS[platform as CookiePlatform] ?? platform
}

/** 将 OneBot 机器人（get_cookies 直接返回 Header 文本）包装为 CookieBot。 */
export function adaptOneBotCookieBot(bot: Pick<Bot, 'internal' | 'selfId'>): CookieBot {
    return {
        platform: 'onebot',
        selfId: bot.selfId,
        getCookieHeader: (domain) => bot.internal.getCookies(domain),
        getLoginUin: async () => {
            try {
                const userId = String(
                    (await bot.internal.getLoginInfo()).user_id
                )
                return /^\d+$/.test(userId) ? userId : null
            } catch {
                return null
            }
        }
    }
}

/** 将 Milky 机器人（get_cookies 返回 { cookies } 对象）包装为 CookieBot。 */
export function adaptMilkyCookieBot(bot: Pick<Bot, 'internal' | 'selfId'>): CookieBot {
    return {
        platform: 'milky',
        selfId: bot.selfId,
        getCookieHeader: async (domain) =>
            (await bot.internal.getCookies(domain)).cookies,
        getLoginUin: async () => {
            try {
                const uin = String((await bot.internal.getLoginInfo()).uin)
                return /^\d+$/.test(uin) ? uin : null
            } catch {
                return null
            }
        }
    }
}

/**
 * 按协议与 selfId 选择已上线的机器人；未指定 selfId 时选择该协议下第一个
 * 已上线的。CONNECT/RECONNECT 阶段尚不能安全调用内部动作。platform 为
 * auto 时按 COOKIE_BOT_PLATFORMS 顺序回退，结果不依赖 bots 的迭代顺序。
 */
export function selectCookieBotView<T extends CookieBotView>(
    bots: Iterable<T>,
    platform: CookiePlatformSelection,
    selfId?: string
): T | undefined {
    // 空字符串 selfId（如控制台清空后的配置）按未指定处理，与历史行为一致。
    const target = selfId || undefined
    const candidates = [...bots]
    const order = platform === 'auto' ? COOKIE_BOT_PLATFORMS : [platform]
    for (const current of order) {
        const hit = candidates.find(
            (bot) =>
                bot.platform === current &&
                (target === undefined || bot.selfId === target) &&
                bot.status === ONLINE_STATUS
        )
        if (hit) return hit
    }
    return undefined
}

/** 选中可用机器人并包装为 CookieBot；未选中时返回 undefined。 */
export function selectCookieBot(
    bots: Iterable<Bot>,
    platform: CookiePlatformSelection,
    selfId?: string
): CookieBot | undefined {
    const bot = selectCookieBotView(bots, platform, selfId)
    if (!bot) return undefined
    return bot.platform === 'milky'
        ? adaptMilkyCookieBot(bot)
        : adaptOneBotCookieBot(bot)
}

/**
 * 经 OneBot/Milky 的 get_cookies 动作获取可用 QQ 空间 Cookie。
 *
 * 逐个域名回退：解析 Header、按验收条件判定（空间票据 + 可识别账号）；
 * 缺 uin 时经 get_login_info 补齐一次。全部失败抛 CookieAcquireError。
 */
export async function acquireQzoneCookies(
    bot: CookieBot
): Promise<QzoneCookieGrant> {
    const failures: string[] = []
    let loginUinResolved = false
    let loginUin: string | null = null
    for (const domain of COOKIE_DOMAIN_CANDIDATES) {
        let header: string
        try {
            header = await bot.getCookieHeader(domain)
        } catch {
            failures.push(`${domain}：获取 Cookie 失败`)
            continue
        }
        const jar = parseCookieHeader(header ?? '')
        if (!hasQzoneTicket(jar)) {
            failures.push(`${domain}：Cookie 缺少空间票据（p_skey/skey/skey2）`)
            continue
        }
        let accountId = extractUin(jar)
        if (!accountId && !loginUinResolved) {
            loginUinResolved = true
            loginUin = await bot.getLoginUin()
        }
        if (!accountId) {
            accountId = loginUin
        }
        if (accountId && canonicalQQ(accountId) !== canonicalQQ(bot.selfId)) {
            failures.push(`${domain}：登录账号与所选机器人不一致`)
            continue
        }
        if (accountId) {
            return { cookies: header, accountId, domain }
        }
        failures.push(`${domain}：无法识别账号`)
    }
    throw new CookieAcquireError(
        `无法从 ${cookiePlatformLabel(bot.platform)} 获取可用的 QQ 空间 Cookie：` +
            `${failures.join('；')}`
    )
}
