import { computed, onScopeDispose, ref } from 'vue'
import type {
  DirectoryHandleLike,
  SegmentInfo,
  WritableLike,
} from '../types/recorder'
import { hasCompleteMoov, patchMp4Duration } from '../utils/mp4Duration'

export type RecorderState = 'idle' | 'recording' | 'stopping'

export type RecorderOptions = {
  segmentMs?: number
  timesliceMs?: number
  videoBitsPerSecond?: number
  audioBitsPerSecond?: number
  mimeType?: string
  filePrefix?: string
  autoPickDirectory?: boolean
}

const MIME_ORDER = [
  // 不要写死 avc1 level / mp4a：1080p + 8kHz 单声道 G.711 流会让
  // 部分 Chrome 版本的 AAC/H.264 编码器拒绝这组参数。
  // 让浏览器自己选择受支持的 level 和音频编码。
  'video/mp4',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

function pickMime(preferred?: string): string {
  if (preferred && MediaRecorder.isTypeSupported(preferred)) return preferred
  return MIME_ORDER.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? ''
}

function extension(mime: string): string {
  return mime.includes('mp4') ? 'mp4' : 'webm'
}

function timeStamp(date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `${pad(date.getMilliseconds(), 3)}`
  )
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function bytesToBlob(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy.buffer])
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return merged
}

/**
 * Records a MediaStream in fixed-length segments.
 *
 * If the File System Access API is available, the user picks a directory once
 * and every segment is streamed to disk. Otherwise each segment is kept in
 * memory and downloaded when it closes, so a long recording never holds every
 * chunk in memory.
 */
export function useSegmentedRecorder() {
  const state = ref<RecorderState>('idle')
  const preparing = ref(false)
  const segments = ref(0)
  const files = ref<SegmentInfo[]>([])
  const mimeType = ref('')
  const dirName = ref('')
  const startedAt = ref<number | null>(null)
  const error = ref<string | null>(null)
  const pendingDownload = ref<{ name: string; blob: Blob } | null>(null)

  let dir: DirectoryHandleLike | null = null
  let mime = ''
  let stream: MediaStream | null = null
  let stopRequested = false
  let pendingStopAt: number | null = null
  let active: MediaRecorder | null = null
  let loop: Promise<void> | null = null

  const lastFile = computed(() => files.value.at(-1)?.name ?? '')

  async function chooseDirectory(): Promise<boolean> {
    const picker = (window as unknown as {
      showDirectoryPicker?: (options?: {
        mode?: 'read' | 'readwrite'
        startIn?: 'videos'
      }) => Promise<DirectoryHandleLike>
    }).showDirectoryPicker

    if (!picker) return false

    try {
      const handle = await picker({ mode: 'readwrite', startIn: 'videos' })
      dir = handle
      dirName.value = handle.name
      return true
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return false
      throw e
    }
  }

  function setDirectory(handle: DirectoryHandleLike | null) {
    dir = handle
    dirName.value = handle?.name ?? ''
  }

  async function start(
    input: MediaStream,
    options: RecorderOptions = {},
  ): Promise<boolean> {
    if (state.value !== 'idle' || preparing.value) return false

    const videoTracks = input.getVideoTracks()
    if (!videoTracks.some((track) => track.readyState === 'live')) {
      throw new Error('MediaStream 中没有可用的视频轨')
    }

    mime = pickMime(options.mimeType)
    if (!mime) throw new Error('当前浏览器不支持 MediaRecorder')

    const picker = (window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker
    if (picker && !dir && options.autoPickDirectory !== false) {
      preparing.value = true
      try {
        const ok = await chooseDirectory()
        if (!ok) return false
      } finally {
        preparing.value = false
      }
    }

    const segmentMs = options.segmentMs ?? 5 * 60_000
    const timesliceMs = options.timesliceMs ?? 1000
    const videoBitsPerSecond = options.videoBitsPerSecond ?? 4_000_000
    const audioBitsPerSecond = options.audioBitsPerSecond ?? 64_000
    const filePrefix = options.filePrefix?.trim() || 'cam'

    stream = input
    mimeType.value = mime
    stopRequested = false
    pendingStopAt = null
    error.value = null
    segments.value = 0
    startedAt.value = Date.now()
    state.value = 'recording'

    loop = (async () => {
      while (!stopRequested) {
        await recordSegment(
          stream!,
          segmentMs,
          timesliceMs,
          videoBitsPerSecond,
          audioBitsPerSecond,
          filePrefix,
        )
      }
    })()
      .catch((e) => {
        error.value = String(e)
      })
      .finally(() => {
        active = null
        state.value = 'idle'
        startedAt.value = null
      })

    return true
  }

  async function recordSegment(
    source: MediaStream,
    segmentMs: number,
    timesliceMs: number,
    videoBitsPerSecond: number,
    audioBitsPerSecond: number,
    filePrefix: string,
  ) {
    segments.value += 1

    const name =
      `${filePrefix}-${timeStamp()}-${String(segments.value).padStart(3, '0')}.` +
      extension(mime)

    let writer: WritableLike | null = null
    let size = 0
    let writeChain: Promise<void> = Promise.resolve()
    const chunks: Blob[] = []

    if (dir) {
      const handle = await dir.getFileHandle(name, { create: true })
      writer = await handle.createWritable()
    }

    const recorder = new MediaRecorder(source, {
      mimeType: mime,
      videoBitsPerSecond,
      audioBitsPerSecond,
    })
    active = recorder

    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })

    let headerBytes: Uint8Array | null = null
    let headerParts: Uint8Array[] = []
    let headerBytesTotal = 0
    let headerChunks = 0
    let headerDone = false
    let headerReadChain: Promise<void> = Promise.resolve()
    let rotating = false
    let segmentEnd: number | null = null
    const rotate = () => {
      if (rotating) return
      rotating = true
      if (recorder.state === 'recording') {
        segmentEnd = performance.now()
        recorder.stop()
      }
    }

    const segmentWallStart = Date.now()
    const segmentStart = performance.now()
    const timer = window.setTimeout(rotate, segmentMs)

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return
      size += event.data.size

      if (!headerDone && mime.includes('mp4')) {
        const blob = event.data
        headerReadChain = headerReadChain
          .then(async () => {
            if (headerDone) return
            const bytes = new Uint8Array(await blob.arrayBuffer())
            headerParts.push(bytes)
            headerBytesTotal += bytes.byteLength
            headerChunks += 1

            const merged = concatBytes(headerParts)
            if (
              hasCompleteMoov(merged) ||
              headerBytesTotal >= 4 * 1024 * 1024
            ) {
              headerBytes = merged
              headerDone = true
            }
          })
          .catch(() => undefined)
      }

      if (writer) {
        const blob = event.data
        writeChain = writeChain
          .then(() => writer!.write(blob))
          .catch((e) => {
            error.value = `写盘失败：${String(e)}`
            stopRequested = true
            rotate()
          })
      } else {
        chunks.push(event.data)
      }

      if (performance.now() - segmentStart >= segmentMs) rotate()
    }

    recorder.onerror = (event: Event) => {
      const mediaError = (event as unknown as { error?: { name?: string; message?: string } })
        .error
      if (mediaError?.name === 'EncodingError') {
        error.value =
          '编码器不接受当前码流参数。请把格式切到 WebM，或打开“兼容模式（720p）”后重试。'
      } else {
        error.value = `录像失败：${String(mediaError ?? event)}`
      }
      stopRequested = true
      rotate()
    }

    recorder.start(timesliceMs)
    await finished
    window.clearTimeout(timer)
    const totalMs = Math.max(
      0,
      (segmentEnd ?? pendingStopAt ?? performance.now()) - segmentStart,
    )
    await writeChain
    await headerReadChain

    const patchedHeader =
      headerBytes && mime.includes('mp4')
        ? patchMp4Duration(headerBytes, totalMs)
        : null

    if (patchedHeader && !writer && chunks.length >= headerChunks) {
      chunks.splice(0, headerChunks, bytesToBlob(patchedHeader))
    }

    if (writer) {
      try {
        if (patchedHeader && writer.seek) {
          await writer.seek(0)
          await writer.write(bytesToBlob(patchedHeader))
        }
        await writer.close()
      } catch (e) {
        error.value = `关闭文件失败：${String(e)}`
      }
    } else if (chunks.length) {
      const blob = new Blob(chunks, { type: mime })
      pendingDownload.value = { name, blob }
      triggerDownload(blob, name)
    }

    if (size > 0) {
      files.value.push({
        name,
        size,
        durationMs: totalMs,
        at: segmentWallStart,
        storage: writer ? 'disk' : 'download',
      })
    }

    if (!source.getVideoTracks().some((track) => track.readyState === 'live')) {
      stopRequested = true
    }
  }

  async function stop(): Promise<void> {
    if (state.value === 'idle') return
    state.value = 'stopping'
    stopRequested = true
    pendingStopAt = performance.now()
    if (active && active.state === 'recording') active.stop()
    if (loop) await loop
    state.value = 'idle'
    startedAt.value = null
  }

  function saveLastDownload() {
    const pending = pendingDownload.value
    if (!pending) return
    triggerDownload(pending.blob, pending.name)
  }

  onScopeDispose(() => {
    void stop()
  })

  return {
    start,
    stop,
    chooseDirectory,
    setDirectory,
    state,
    preparing,
    segments,
    files,
    mimeType,
    dirName,
    startedAt,
    lastFile,
    error,
    pendingDownload,
    saveLastDownload,
  }
}
