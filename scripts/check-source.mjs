import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceDir = resolve(root, 'src')
const sourceFiles = (await readdir(sourceDir, { withFileTypes: true }))
  .filter(entry => entry.isFile())
  .map(entry => entry.name)
const javascript = [resolve(root, 'server.js'), ...sourceFiles
  .filter(name => name.endsWith('.js'))
  .sort()
  .map(name => resolve(sourceDir, name))]
const declarations = ['server.d.ts', ...sourceFiles.filter(name => name.endsWith('.d.ts'))]

for (const file of javascript) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Source syntax check failed for ' + file)
}

console.log('Checked ' + javascript.length + ' JavaScript files. Found ' +
  declarations.length + ' declaration files. No compilation output is required.')
