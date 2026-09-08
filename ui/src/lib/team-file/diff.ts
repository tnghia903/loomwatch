/** A deliberately read-only, line-oriented comparison. It never attempts to merge YAML. */
export function unifiedYamlDiff(disk: string, memory: string): string {
  const left = disk.split('\n')
  const right = memory.split('\n')
  const output = ['--- disk', '+++ in memory']
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) {
      if (left[index] !== undefined) output.push(` ${left[index]}`)
      continue
    }
    if (left[index] !== undefined) output.push(`-${left[index]}`)
    if (right[index] !== undefined) output.push(`+${right[index]}`)
  }
  return output.join('\n')
}
