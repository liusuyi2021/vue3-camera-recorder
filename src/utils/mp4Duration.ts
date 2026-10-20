const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'mvex',
  'moof',
  'traf',
])

type BoxVisitor = (
  type: string,
  offset: number,
  size: number,
  headerSize: number,
) => void

function walkBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: BoxVisitor,
) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = start

  while (offset + 8 <= end) {
    let size = view.getUint32(offset)
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    )
    let headerSize = 8

    if (size === 1) {
      if (offset + 16 > end) return
      size = Number(view.getBigUint64(offset + 8))
      headerSize = 16
    } else if (size === 0) {
      size = end - offset
    }

    if (size < headerSize || offset + size > end) return

    visit(type, offset, size, headerSize)
    if (CONTAINERS.has(type)) {
      walkBoxes(bytes, offset + headerSize, offset + size, visit)
    }
    offset += size
  }
}

/**
 * MediaRecorder 的 MP4 是 fragmented MP4，mvhd 里的 duration 通常是 0。
 * 播放器只读头部时就会显示错误的总时长，或显示“无时长”。
 * 这里只就地改 duration 字段，不改变文件长度和分片偏移。
 */
export function patchMp4Duration(
  bytes: Uint8Array,
  totalMs: number,
): Uint8Array | null {
  if (bytes.byteLength < 16 || totalMs <= 0) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let movieTimescale = 0
  let hasMvhd = false

  walkBoxes(bytes, 0, bytes.byteLength, (type, offset, size, headerSize) => {
    if (type !== 'mvhd') return
    const payload = offset + headerSize
    const version = bytes[payload]
    movieTimescale =
      version === 1
        ? view.getUint32(payload + 20)
        : view.getUint32(payload + 12)
    hasMvhd = true
    void size
  })

  if (!hasMvhd || movieTimescale === 0) return null

  const patched = new Uint8Array(bytes)
  const patchedView = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  )

  const writeDuration = (offset: number, version: number, value: number) => {
    const safe = Math.max(0, Math.round(value))
    if (version === 1) {
      patchedView.setBigUint64(offset, BigInt(safe), false)
    } else {
      patchedView.setUint32(offset, Math.min(0xffffffff, safe), false)
    }
  }

  walkBoxes(bytes, 0, bytes.byteLength, (type, offset, _size, headerSize) => {
    const payload = offset + headerSize
    const version = bytes[payload]

    if (type === 'mvhd') {
      const timescale =
        version === 1
          ? view.getUint32(payload + 20)
          : view.getUint32(payload + 12)
      const durationOffset = payload + (version === 1 ? 24 : 16)
      writeDuration(durationOffset, version, (totalMs * timescale) / 1000)
      return
    }

    if (type === 'tkhd') {
      const durationOffset = payload + (version === 1 ? 28 : 20)
      writeDuration(
        durationOffset,
        version,
        (totalMs * movieTimescale) / 1000,
      )
      return
    }

    if (type === 'mdhd') {
      const timescale =
        version === 1
          ? view.getUint32(payload + 20)
          : view.getUint32(payload + 12)
      const durationOffset = payload + (version === 1 ? 24 : 16)
      writeDuration(durationOffset, version, (totalMs * timescale) / 1000)
      return
    }

    if (type === 'mehd') {
      writeDuration(payload + 4, version, (totalMs * 1000) / 1000)
    }
  })

  return patched
}

/** 判断首块是否已经包含完整的 moov，避免在分片边界处误改。 */
export function hasCompleteMoov(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let complete = false

  walkBoxes(bytes, 0, bytes.byteLength, (type, offset, size) => {
    if (type === 'moov' && offset + size <= bytes.byteLength) complete = true
  })

  // walkBoxes 遇到不完整盒子会提前返回；上面的判断只在盒子确实完整时为 true。
  return complete && view.byteLength > 0
}
