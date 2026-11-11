export function isUserAllowed(userId: string | undefined, allowed: readonly string[], platform: string | undefined): boolean {
    return (platform === 'onebot' || platform === 'milky' || platform === 'qq') &&
        userId !== undefined && allowed.includes(userId)
}
