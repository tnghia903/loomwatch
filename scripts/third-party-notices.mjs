// Writes ui/public/third-party-notices.txt: the license and copyright notices of every open-source
// package built into LoomWatch, the Rust crates inside loomwatchd and the npm packages bundled into
// the browser app. loomwatchd embeds ui/dist, so the file ships inside the program and is served at
// /third-party-notices.txt. Run it again whenever a dependency changes:
//   node scripts/third-party-notices.mjs
// Needs pnpm and cargo-about (cargo install cargo-about --locked --features cli); about.toml says
// which crates count and which license is quoted when a crate offers a choice.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(repo, 'ui/public/third-party-notices.txt')
const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)/i
const WIDTH = 78

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

function licenseFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

// Some crates (ring) carry their notices as source-file headers, which cargo-about quotes along
// with the code under them. Keep the leading comment only, without its comment markers.
function headerComment(text) {
  const lines = text.trim().split('\n')
  if (lines[0].startsWith('/*')) {
    const end = lines.findIndex((line) => line.includes('*/'))
    return lines
      .slice(0, end + 1)
      .map((line) => line.replace(/^\s*\/?\*+\/?\s?/, '').replace(/\s*\*+\/\s*$/, ''))
      .join('\n')
      .trim()
  }
  const marker = lines[0].startsWith('//') ? '//' : '#'
  const end = lines.findIndex((line) => !line.startsWith(marker))
  return lines
    .slice(0, end === -1 ? lines.length : end)
    .map((line) => line.slice(marker.length).replace(/^ /, ''))
    .join('\n')
    .trim()
}

// Packages quoting the exact same text share one entry.
function addNotice(groups, license, text, user) {
  const key = `${license}\n${text}`
  if (!groups.has(key)) groups.set(key, { license, text, users: new Set() })
  groups.get(key).users.add(user)
}

function rustNotices() {
  const about = JSON.parse(run('cargo', ['about', 'generate', '--format', 'json', '--locked'], repo))
  const groups = new Map()
  // cargo-about falls back to the standard license text, with no copyright line, when it cannot
  // match one of a crate's licenses to a file (aws-lc-sys ships one combined LICENSE). Quote such a
  // crate's own license files instead, and keep the standard text only for crates that have none.
  const fellBack = new Set(
    about.licenses.filter((license) => !license.source_path).flatMap((license) => license.used_by.map(({ crate }) => crate.id)),
  )
  const quotedFiles = new Set()
  for (const { package: pkg } of about.crates) {
    if (!fellBack.has(pkg.id)) continue
    const dir = dirname(pkg.manifest_path)
    for (const name of licenseFiles(dir)) {
      addNotice(groups, `${pkg.license} (${name})`, readFileSync(join(dir, name), 'utf8').trim(), `${pkg.name} ${pkg.version}`)
      quotedFiles.add(pkg.id)
    }
  }
  for (const license of about.licenses) {
    const source = license.source_path ?? ''
    const text = source && !LICENSE_FILE.test(basename(source)) ? headerComment(license.text) : license.text.trim()
    const name = source ? license.name : `${license.name} (standard text: the crate ships no license file)`
    for (const { crate } of license.used_by) {
      if (!source && quotedFiles.has(crate.id)) continue
      addNotice(groups, name, text, `${crate.name} ${crate.version}`)
    }
  }
  return { groups, count: about.crates.length }
}

function npmNotices() {
  const byLicense = JSON.parse(run('pnpm', ['licenses', 'list', '--prod', '--json'], join(repo, 'ui')))
  const groups = new Map()
  let count = 0
  for (const [license, packages] of Object.entries(byLicense)) {
    for (const pkg of packages) {
      pkg.paths.forEach((path, index) => {
        const files = licenseFiles(path)
        if (files.length === 0) {
          throw new Error(`${pkg.name} ships no license file; quote its license in this script by hand`)
        }
        const text = files.map((name) => readFileSync(join(path, name), 'utf8').trim()).join('\n\n')
        addNotice(groups, license, text, `${pkg.name} ${pkg.versions[index]}`)
        count += 1
      })
    }
  }
  return { groups, count }
}

function part(title, { groups }) {
  const entries = [...groups.values()]
    .map((group) => ({ ...group, users: [...group.users].sort() }))
    .sort((a, b) => a.license.localeCompare(b.license) || a.users[0].localeCompare(b.users[0]))
  const lines = ['='.repeat(WIDTH), title, '='.repeat(WIDTH), '']
  for (const entry of entries) {
    lines.push('-'.repeat(WIDTH), entry.license, `Used by: ${entry.users.join(', ')}`, '-'.repeat(WIDTH), '')
    lines.push(entry.text, '')
  }
  return lines.join('\n')
}

const rust = rustNotices()
const npm = npmNotices()
const header = `Third-party software in LoomWatch
=================================

LoomWatch is built with the open-source software listed below. Each entry
quotes the license it is used under, with its authors' copyright notices.

The fonts (Inter, Instrument Serif and JetBrains Mono) are under the SIL Open
Font License 1.1: see fonts/OFL.txt next to this file.

Part 1: ${rust.count} Rust crates inside loomwatchd
Part 2: ${npm.count} packages in the browser app

Generated by scripts/third-party-notices.mjs. Do not edit by hand.
`
writeFileSync(
  out,
  [header, part('PART 1: RUST CRATES INSIDE LOOMWATCHD', rust), part('PART 2: PACKAGES IN THE BROWSER APP', npm)]
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n*$/, '\n'),
)
console.log(`wrote ${out}: ${rust.count} crates, ${npm.count} npm packages`)
