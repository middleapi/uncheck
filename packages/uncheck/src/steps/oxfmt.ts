import { binStep } from '../step'

export const oxfmt = binStep({
  name: 'oxfmt',
  does: 'Check formatting with oxfmt',
  args: fix => (fix ? [] : ['--check']),
})
