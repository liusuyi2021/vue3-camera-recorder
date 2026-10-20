<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useDemoStream } from '../composables/useDemoStream'
import { useSegmentedRecorder } from '../composables/useSegmentedRecorder'
import { useWhep } from '../composables/useWhep'
import type { CameraConfig, TileUpdate } from '../types/camera'
import type { DirectoryHandleLike } from '../types/recorder'
import {
  createCompatStream,
  type CompatStreamHandle,
} from '../utils/compatStream'

const props = defineProps<{
  camera: CameraConfig
  index: number
  directory: DirectoryHandleLike | null
  segmentMinutes: number
  bitrateMbps: number
  format: 'auto' | 'webm' | 'mp4'
  compatMode: boolean
  now: number
}>()

const emit = defineEmits<{
  (event: 'update', value: TileUpdate): void
  (event: 'edit', id: string): void
}>()

const cam = useWhep()
const demo = useDemoStream()
const rec = useSegmentedRecorder()

const { stream: camStream, state: camState, error: camError } = cam
const { stream: demoStream } = demo
const {
  state: recState,
  preparing: recPreparing,
  files: recFiles,
  startedAt: recStartedAt,
  error: recError,
  pendingDownload,
  saveLastDownload,
} = rec

const source = shallowRef<MediaStream>()
const videoEl = ref<HTMLVideoElement>()
const tileEl = ref<HTMLElement>()
const mode = ref<'camera' | 'demo' | null>(null)
const muted = ref(true)
const localNotice = ref('')

let compat: CompatStreamHandle | null = null

const isRecording = computed(() => recState.value === 'recording')
const connected = computed(() => !!source.value)

const statusLabel = computed(() => {
  if (mode.value === 'demo') return 'DEMO'
  switch (camState.value) {
    case 'connected':
      return 'LIVE'
    case 'connecting':
      return 'LINK'
    case 'reconnecting':
      return 'RETRY'
    case 'failed':
      return 'ERROR'
    default:
      return 'OFFLINE'
  }
})

const statusClass = computed(() => {
  if (mode.value === 'demo') return 'is-demo'
  if (camState.value === 'connected') return 'is-live'
  if (camState.value === 'failed') return 'is-error'
  return 'is-idle'
})

const elapsedMs = computed(() => {
  if (!isRecording.value || !recStartedAt.value) return 0
  return Math.max(0, props.now - recStartedAt.value)
})

const progress = computed(() => {
  if (!isRecording.value) return 0
  const segmentMs = props.segmentMinutes * 60_000
  return Math.min(0.999, (elapsedMs.value % segmentMs) / segmentMs)
})

const currentSegment = computed(() => {
  if (!isRecording.value) return 0
  return Math.floor(elapsedMs.value / (props.segmentMinutes * 60_000)) + 1
})

const elapsedLabel = computed(() => formatTime(elapsedMs.value))
const errorText = computed(
  () => camError.value || recError.value || localNotice.value || '',
)

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function formatTime(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`
}

function pushUpdate() {
  emit('update', {
    id: props.camera.id,
    name: props.camera.name,
    connected: !!source.value,
    recording: recState.value === 'recording',
    startedAt: recStartedAt.value,
    files: [...recFiles.value],
    error: errorText.value || null,
  })
}

watch(
  [camState, recState, recStartedAt, recFiles, errorText, source, () => props.camera.name],
  pushUpdate,
  { deep: true, immediate: true },
)

watch(
  () => props.directory,
  (handle) => rec.setDirectory(handle),
  { immediate: true },
)

async function attach(stream: MediaStream | undefined) {
  source.value = stream
  const element = videoEl.value
  if (!element) return
  element.srcObject = stream ?? null
  element.muted = muted.value
  if (stream) await element.play().catch(() => undefined)
}

watch(camStream, async (stream) => {
  if (mode.value !== 'camera') return
  if (recState.value !== 'idle') {
    await rec.stop()
    releaseCompat()
  }
  await attach(stream)
})

watch(demoStream, async (stream) => {
  if (mode.value !== 'demo') return
  await attach(stream)
})

watch(muted, (value) => {
  if (videoEl.value) videoEl.value.muted = value
})

watch(recState, (value) => {
  if (value === 'idle') releaseCompat()
})

function releaseCompat() {
  compat?.stop()
  compat = null
}

function waitForStream(timeoutMs = 15000): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    if (cam.stream.value) return resolve(cam.stream.value)
    if (camState.value === 'failed') {
      return reject(new Error(camError.value ?? '连接失败'))
    }

    let stopWatch: (() => void) | null = null
    let timer: number | undefined

    stopWatch = watch(
      [cam.stream, camState],
      ([stream, state]) => {
        if (stream) {
          stopWatch?.()
          if (timer !== undefined) window.clearTimeout(timer)
          resolve(stream)
        } else if (state === 'failed') {
          stopWatch?.()
          if (timer !== undefined) window.clearTimeout(timer)
          reject(new Error(camError.value ?? '连接失败'))
        }
      },
      { immediate: true },
    )

    timer = window.setTimeout(() => {
      stopWatch?.()
      reject(new Error('连接超时'))
    }, timeoutMs)
  })
}

async function connect(): Promise<MediaStream> {
  const url = props.camera.url.trim()
  if (!url) throw new Error('未配置 WHEP 地址')
  if (recState.value !== 'idle') await rec.stop()
  releaseCompat()
  demo.stop()
  cam.stop()
  mode.value = 'camera'
  localNotice.value = ''
  cam.start(url)
  return waitForStream()
}

async function useDemo() {
  if (recState.value !== 'idle') await rec.stop()
  releaseCompat()
  cam.stop()
  demo.stop()
  mode.value = 'demo'
  localNotice.value = ''
  demo.start(props.camera.name)
  await attach(demo.stream.value)
}

async function disconnect() {
  if (recState.value !== 'idle') await rec.stop()
  releaseCompat()
  cam.stop()
  demo.stop()
  mode.value = null
  await attach(undefined)
}

async function startRecording(): Promise<boolean> {
  if (recState.value === 'recording') return true
  if (recPreparing.value) return false

  let stream = source.value
  if (
    stream &&
    !stream.getVideoTracks().some((track) => track.readyState === 'live')
  ) {
    await disconnect()
    stream = undefined
  }
  if (!stream) stream = await connect()

  let preferred: string | undefined
  if (props.format === 'mp4') preferred = 'video/mp4'
  else if (props.format === 'webm') preferred = 'video/webm;codecs=vp9,opus'

  releaseCompat()
  let input = stream
  if (props.compatMode) {
    if (!videoEl.value) throw new Error('视频元素还没有准备好')
    compat = createCompatStream(videoEl.value, stream)
    input = compat.stream
  }

  try {
    const ok = await rec.start(input, {
      segmentMs: props.segmentMinutes * 60_000,
      videoBitsPerSecond: props.bitrateMbps * 1_000_000,
      mimeType: preferred,
      filePrefix: props.camera.id,
      autoPickDirectory: false,
    })
    if (!ok) throw new Error('录像未启动')
    return true
  } catch (e) {
    releaseCompat()
    throw e
  }
}

async function stopRecording() {
  if (recState.value === 'idle') return
  await rec.stop()
  releaseCompat()
}

async function toggleRecord() {
  try {
    if (recState.value !== 'idle') await stopRecording()
    else await startRecording()
  } catch (e) {
    localNotice.value = String(e)
  }
}

function handleConnect() {
  connect().catch((e) => {
    localNotice.value = String(e)
  })
}

function handleDemo() {
  useDemo().catch((e) => {
    localNotice.value = String(e)
  })
}

async function fullscreen() {
  const element = tileEl.value
  if (!element) return
  if (document.fullscreenElement) {
    await document.exitFullscreen()
  } else {
    await element.requestFullscreen?.()
  }
}

onBeforeUnmount(() => {
  void disconnect()
})

defineExpose({
  connect,
  disconnect,
  startRecording,
  stopRecording,
  useDemo,
})
</script>

<template>
  <article
    ref="tileEl"
    class="camera-tile"
    :class="{ 'is-recording': isRecording, 'is-connected': connected }"
  >
    <header class="tile-head">
      <span class="tile-index mono">{{ pad(index + 1) }}</span>
      <strong class="tile-name" :title="camera.name">{{ camera.name }}</strong>
      <span class="tile-status mono" :class="statusClass">
        <i></i>{{ statusLabel }}
      </span>
      <button
        class="tile-icon"
        type="button"
        title="设置信号源"
        @click="emit('edit', camera.id)"
      >
        SET
      </button>
    </header>

    <div class="tile-video">
      <video ref="videoEl" autoplay playsinline :muted="muted"></video>

      <div v-if="!connected" class="tile-empty">
        <p class="tile-empty-label">NO SIGNAL</p>
        <p class="tile-empty-name">{{ camera.name }}</p>
        <div class="tile-empty-actions">
          <button class="mini-button is-primary" type="button" @click="handleConnect">
            连接
          </button>
          <button class="mini-button" type="button" @click="handleDemo">
            演示
          </button>
        </div>
      </div>

      <div class="tile-hud">
        <span>{{ mode === 'demo' ? 'DEMO' : 'WHEP' }}</span>
        <span v-if="isRecording" class="tile-rec-flag">
          <i></i>REC {{ elapsedLabel }}
        </span>
      </div>

      <div class="tile-tools">
        <button class="tile-tool" type="button" @click="muted = !muted">
          {{ muted ? 'MUTE' : 'SOUND' }}
        </button>
        <button class="tile-tool" type="button" @click="fullscreen">
          FULL
        </button>
      </div>

      <div class="tile-progress" aria-hidden="true">
        <span :style="{ transform: `scaleX(${progress})` }"></span>
      </div>
    </div>

    <footer class="tile-foot">
      <button
        class="tile-rec-button"
        :class="{ 'is-on': isRecording }"
        type="button"
        :disabled="recPreparing || recState === 'stopping'"
        @click="toggleRecord"
      >
        <i></i>
        {{
          isRecording
            ? 'STOP'
            : recPreparing
              ? 'PREP'
              : 'REC'
        }}
      </button>

      <span class="mono tile-time">{{ elapsedLabel }}</span>
      <span class="mono tile-seg">
        SEG {{ currentSegment ? pad(currentSegment) : '--' }}
      </span>
      <span class="mono tile-files">{{ recFiles.length }} F</span>

      <button
        v-if="pendingDownload && !directory"
        class="tile-save"
        type="button"
        title="重新保存最近一段"
        @click="saveLastDownload"
      >
        SAVE
      </button>
    </footer>

    <p v-if="errorText" class="tile-error" :title="errorText">
      {{ errorText }}
    </p>
  </article>
</template>
