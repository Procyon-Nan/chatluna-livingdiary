export const escapeXmlText = (value: string): string =>
    value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')

/** 以同名开闭标签包裹转义后的数据块正文，产出逐行数组。 */
export const formatXmlBlock = (name: string, value: string): string[] => [
    `<${name}>`,
    escapeXmlText(value),
    `</${name}>`
]
