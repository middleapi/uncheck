#!/usr/bin/env node

import { enableCompileCache } from 'node:module'

// The cache only covers modules compiled after it is on, hence the import that follows it.
enableCompileCache()

await import('./cli')
