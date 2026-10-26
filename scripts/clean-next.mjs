import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectory = resolve(projectRoot, '.next')

// Clear only this project's generated Next.js output, including absolute paths
// embedded by the previously installed framework. Stop the dev server first.
if (dirname(buildDirectory) !== projectRoot) {
  throw new Error('Refusing to clean outside the project directory')
}

rmSync(buildDirectory, { recursive: true, force: true, maxRetries: 3 })
console.log('Cleared Next.js build cache')
