import { binStep } from '../step'

export const oxlint = binStep({
  name: 'oxlint',
  does: 'Lint with oxlint',
  args: fix => (fix ? ['--fix'] : []),
})
