import { styleText } from 'node:util'

export const colors = styleText('bold', ' ') !== ' '

const paint = (style: Parameters<typeof styleText>[0]) => (text: string) => styleText(style, text)

export const bold = paint('bold')
export const dim = paint('dim')
export const red = paint('red')
export const green = paint('green')

/** A few paths as they are, more as a count, so a line stays readable. */
export function listFiles(files: ReadonlyArray<string>): string {
  return files.length <= 3 ? files.join(' ') : `[${files.length} files]`
}
