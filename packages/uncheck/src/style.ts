import process from 'node:process'
import { styleText } from 'node:util'

export const colors =
  !('NO_COLOR' in process.env) &&
  ((process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') || process.stdout.isTTY === true)

const paint = (style: Parameters<typeof styleText>[0]) => (text: string) =>
  colors ? styleText(style, text, { validateStream: false }) : text

export const bold = paint('bold')
export const dim = paint('dim')
export const red = paint('red')
export const green = paint('green')
