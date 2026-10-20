<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch,
} from 'vue'
import CameraSettings from './components/CameraSettings.vue'
import CameraTile from './components/CameraTile.vue'
import type { CameraConfig, TileUpdate } from './types/camera'
import type { DirectoryHandleLike } from './types/recorder'

const CAMERA_KEY = 'vue3-grid-recorder.cameras.v1'
const LAYOUT_KEY = 'vue3-grid-recorder.layout.v1'
const defaultWhep = import.meta.env.VITE_WHEP_URL || ''

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function defaultCameras(): CameraConfig[] {
  return Array.from({ length: 9 }, (_, index) => ({
    id: `cam${pad(index + 1)}`,
    name: `CAM ${pad(index + 1)}`,
    url: index === 0 ? defaultWhep : '',
  }))
}

function loadCameras(): CameraConfig[] {
  const fallback = defaultCameras()
  try {
    const raw = localStorage.getItem(CAMERA_KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback

    return fallback.map((base, index) => {
      const item = parsed[index]
      if (!item || typeof item !== 'object') return base
      const record = item as Record<string, unknown>
      return {
        ...base,
        name:
          typeof record.name === 'string' && record.name.trim()
            ? record.name.slice(0, 24)
            : base.name,
        url: typeof record.url === 'string' ? record.url : base.url,
      }
    })
  } catch {
    return fallback
  }
}

function loadLayout(): 4 | 9 {
  try {
    return Number(localStorage.getItem(LAYOUT_KEY)) === 9 ? 9 : 4
  } catch {
    return 4
  }
}

const cameras = ref<CameraConfig[]>(loadCameras())
const layout = ref<4 | 9>(loadLayout())
const visibleCameras = computed(() => cameras.value.slice(0, layout.value))

const segmentMinutes = ref(5)
const bitrateMbps = ref(2)
const format = ref<'auto' | 'webm' | 'mp4'>('auto')
const compatMode = ref(false)

const showSettings = ref(false)
const settingsFocusId = ref<string | null>(null)
const secureContext = ref(window.isSecureContext)
const hasDirectoryPicker = ref(
  typeof (window as unknown as { showDirectoryPicker?: unknown })
    .showDirectoryPicker === 'function',
)
const topLevel = ref(window.top === window)
const directoryHandle = shallowRef<DirectoryHandleLike | null>(null)
const directoryName = ref('')

const notice = ref('')
const now = ref(Date.now())
const busy = ref(false)
const tileStates = reactive<Record<string, TileUpdate>>({})
const tileRefs = new Map<string, any>()

let clock: number | undefined
let noticeTimer: number | undefined

const visibleStates = computed(() =>
  visibleCameras.value
    .map((camera) => tileStates[camera.id])
    .filter((state): state is TileUpdate => !!state),
)

const connectedCount = computed(
  () => visibleStates.value.filter((state) => state.connected).length,
)
const recordingCount = computed(
  () => visibleStates.value.filter((state) => state.recording).length,
)

const allFiles = computed(() =>
  Object.values(tileStates)
    .flatMap((state) =>
      state.files.map((file) => ({
        ...file,
        cameraId: state.id,
        cameraName: state.name,
      })),
    )
    .sort((a, b) => b.at - a.at),
)

const totalBytes = computed(() =>
  allFiles.value.reduce((sum, file) => sum + file.size, 0),
)

const layoutColumns = computed(() => (layout.value === 4 ? 2 : 3))

const clockText = computed(() =>
  new Date(now.value).toLocaleTimeString('zh-CN', { hour12: false }),
)

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function setTileRef(id: string, element: unknown) {
  if (element) tileRefs.set(id, element)
  else tileRefs.delete(id)
}

function handleUpdate(update: TileUpdate) {
  tileStates[update.id] = update
}

function openSettings() {
  settingsFocusId.value = null
  showSettings.value = true
}

function handleEdit(id: string) {
  settingsFocusId.value = id
  showSettings.value = true
}

function closeSettings() {
  showSettings.value = false
}

function changeLayout(next: 4 | 9) {
  if (next < layout.value && recordingCount.value > 0) {
    const ok = window.confirm(
      '切换布局会停止并卸载隐藏的宫格，当前录像会结束。继续？',
    )
    if (!ok) return
  }
  layout.value = next
}

async function chooseDirectory() {
  if (!secureContext.value) {
    notice.value =
      '目录写盘需要 HTTPS 或 localhost。当前页面不是安全上下文，浏览器已禁用文件系统 API。'
    return
  }
  if (!topLevel.value) {
    notice.value = '目录写盘不能在跨域 iframe 中使用，请在新窗口打开本页面。'
    return
  }
  if (!hasDirectoryPicker.value) {
    notice.value = '当前浏览器不支持目录写盘，请使用 Chrome/Edge 86+。'
    return
  }

  const picker = (window as unknown as {
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite'
      startIn?: 'videos'
    }) => Promise<DirectoryHandleLike>
  }).showDirectoryPicker
  if (!picker) return

  try {
    const handle = await picker({ mode: 'readwrite', startIn: 'videos' })
    directoryHandle.value = handle
    directoryName.value = handle.name
    notice.value = `保存目录：${handle.name}`
  } catch (e) {
    if ((e as DOMException)?.name !== 'AbortError') {
      notice.value = String(e)
    }
  }
}

async function runAll(
  label: string,
  action: (tile: any) => Promise<unknown>,
) {
  const targets = visibleCameras.value
    .map((camera) => tileRefs.get(camera.id))
    .filter(Boolean)

  if (!targets.length) return

  busy.value = true
  try {
    const results = await Promise.allSettled(
      targets.map((tile) => action(tile)),
    )
    const failed = results.filter((result) => result.status === 'rejected').length
    notice.value =
      failed > 0
        ? `${label}：${targets.length - failed}/${targets.length} 路成功，${failed} 路失败`
        : `${label}：${targets.length} 路成功`
  } finally {
    busy.value = false
  }
}

function connectAll() {
  return runAll('连接', (tile) => tile.connect())
}

function startAll() {
  if (!directoryHandle.value) {
    notice.value =
      '未选择保存目录，将按段下载；多路同时下载可能被浏览器拦截。'
  }
  return runAll('开始录像', (tile) => tile.startRecording())
}

function stopAll() {
  return runAll('停止录像', (tile) => tile.stopRecording())
}

function disconnectAll() {
  return runAll('断开', (tile) => tile.disconnect())
}

function demoAll() {
  return runAll('演示信号', (tile) => tile.useDemo())
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (recordingCount.value === 0) return
  event.preventDefault()
  event.returnValue = ''
}

watch(
  cameras,
  (value) => {
    try {
      localStorage.setItem(CAMERA_KEY, JSON.stringify(value))
    } catch {
      // localStorage 不可用时不影响当前会话。
    }
  },
  { deep: true },
)

watch(layout, (value) => {
  try {
    localStorage.setItem(LAYOUT_KEY, String(value))
  } catch {
    // 忽略存储失败。
  }
})

watch(notice, (value) => {
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
  if (!value) return
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 8000)
})

onMounted(() => {
  clock = window.setInterval(() => {
    now.value = Date.now()
  }, 500)
  window.addEventListener('beforeunload', beforeUnload)
})

onBeforeUnmount(() => {
  if (clock !== undefined) window.clearInterval(clock)
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <div class="app-shell grid-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><span></span></span>
        <div>
          <p class="brand-kicker">
            GRID RECORDER / {{ layout === 4 ? '4-CH' : '9-CH' }}
          </p>
          <h1>多路本地录像</h1>
        </div>
      </div>

      <div class="topbar-right">
        <span class="status-pill is-connected">
          <i></i>LIVE {{ connectedCount }}/{{ visibleCameras.length }}
        </span>
        <span class="status-pill" :class="{ 'is-recording': recordingCount > 0 }">
          <i></i>REC {{ recordingCount }}
        </span>
        <span class="clock mono">{{ clockText }}</span>
      </div>
    </header>

    <section class="commandbar">
      <div class="layout-switch" role="group" aria-label="宫格布局">
        <button
          type="button"
          :class="{ active: layout === 4 }"
          @click="changeLayout(4)"
        >
          2×2
        </button>
        <button
          type="button"
          :class="{ active: layout === 9 }"
          @click="changeLayout(9)"
        >
          3×3
        </button>
      </div>

      <div class="command-actions">
        <button
          class="primary-button"
          type="button"
          :disabled="busy"
          @click="connectAll"
        >
          全部连接
        </button>
        <button
          class="record-all"
          type="button"
          :disabled="busy"
          @click="startAll"
        >
          全部录像
        </button>
        <button
          class="ghost-button"
          type="button"
          :disabled="busy"
          @click="stopAll"
        >
          全部停止
        </button>
        <button
          class="ghost-button"
          type="button"
          :disabled="busy"
          @click="disconnectAll"
        >
          全部断开
        </button>
        <button
          class="ghost-button"
          type="button"
          :disabled="busy"
          @click="demoAll"
        >
          演示全部
        </button>
      </div>

      <div class="command-stats mono">
        <span>{{ allFiles.length }} FILES</span>
        <span>{{ formatBytes(totalBytes) }}</span>
      </div>
    </section>

    <p v-if="notice" class="global-notice">{{ notice }}</p>
    <p v-if="!secureContext" class="global-warning">
      HTTP 模式：目录写盘不可用，多路同时下载可能被浏览器拦截。建议使用
      HTTPS。
    </p>
    <p v-else-if="!hasDirectoryPicker" class="global-warning">
      当前浏览器不支持目录写盘，将按段下载；多路同时下载可能被拦截。
    </p>
    <p v-else-if="!directoryHandle" class="global-warning">
      还没有选择保存目录。多路同时按段下载容易被浏览器拦截，建议先选择目录。
    </p>

    <main class="workspace grid-workspace">
      <section class="camera-grid" :style="{ '--cols': layoutColumns }">
        <CameraTile
          v-for="(camera, index) in visibleCameras"
          :key="camera.id"
          :ref="(element) => setTileRef(camera.id, element)"
          :camera="camera"
          :index="index"
          :directory="directoryHandle"
          :segment-minutes="segmentMinutes"
          :bitrate-mbps="bitrateMbps"
          :format="format"
          :compat-mode="compatMode"
          :now="now"
          @update="handleUpdate"
          @edit="handleEdit"
        />
      </section>

      <aside class="deck">
        <section class="deck-block">
          <div class="block-head">
            <span class="eyebrow">OUTPUT</span>
            <span class="mono block-meta">
              {{ directoryName || 'DOWNLOAD' }}
            </span>
          </div>

          <div class="storage-row">
            <div>
              <span class="eyebrow">DIRECTORY</span>
              <p>{{ directoryName || '按段下载' }}</p>
            </div>
            <button
              class="ghost-button small"
              type="button"
              @click="chooseDirectory"
            >
              选择目录
            </button>
          </div>

          <div class="capability-row" aria-label="目录写盘能力">
            <span
              class="cap"
              :class="{ ok: secureContext, bad: !secureContext }"
            >
              SECURE
            </span>
            <span
              class="cap"
              :class="{ ok: hasDirectoryPicker, bad: !hasDirectoryPicker }"
            >
              FS API
            </span>
            <span class="cap" :class="{ ok: topLevel, bad: !topLevel }">
              TOP
            </span>
          </div>

          <p class="hint">
            所有宫格共用这个目录；每路文件以 cam01、cam02… 前缀区分。
          </p>
        </section>

        <section class="deck-block">
          <div class="block-head">
            <span class="eyebrow">RECORD DEFAULTS</span>
            <span class="mono block-meta">
              {{ format === 'auto' ? 'AUTO' : format.toUpperCase() }}
            </span>
          </div>

          <div class="field-grid">
            <label class="field">
              <span>分段长度</span>
              <select v-model.number="segmentMinutes">
                <option :value="1">1 分钟</option>
                <option :value="5">5 分钟</option>
                <option :value="10">10 分钟</option>
                <option :value="15">15 分钟</option>
              </select>
            </label>
            <label class="field">
              <span>每路码率</span>
              <select v-model.number="bitrateMbps">
                <option :value="1">1 Mbps</option>
                <option :value="2">2 Mbps</option>
                <option :value="3">3 Mbps</option>
                <option :value="4">4 Mbps</option>
                <option :value="6">6 Mbps</option>
              </select>
            </label>
          </div>

          <label class="field">
            <span>格式</span>
            <select v-model="format">
              <option value="auto">自动（优先 MP4）</option>
              <option value="webm">WebM</option>
              <option value="mp4">MP4</option>
            </select>
          </label>

          <label class="toggle-row">
            <input v-model="compatMode" type="checkbox" />
            <span>
              兼容模式（每路 720p 重绘）
              <small>4 路/9 路同时录制更稳，CPU 更低</small>
            </span>
          </label>

          <p class="hint">
            修改在下次开始录像时生效。4 路 1080p 同时重编码很吃 CPU，建议使用子码流。
          </p>
        </section>

        <section class="deck-block files-block">
          <div class="block-head">
            <span class="eyebrow">FILES</span>
            <span class="mono block-meta">{{ allFiles.length }}</span>
          </div>

          <ul v-if="allFiles.length" class="file-list">
            <li
              v-for="file in allFiles.slice(0, 60)"
              :key="file.cameraId + file.name"
            >
              <div>
                <span class="file-cam mono">{{ file.cameraName }}</span>
                <strong>{{ file.name }}</strong>
                <span>
                  {{ formatBytes(file.size) }} ·
                  {{ formatDuration(file.durationMs) }} ·
                  {{ file.storage === 'disk' ? '已写盘' : '已下载' }}
                </span>
              </div>
              <span class="file-time mono">
                {{
                  new Date(file.at).toLocaleTimeString('zh-CN', {
                    hour12: false,
                  })
                }}
              </span>
            </li>
          </ul>

          <p v-else class="empty-note">
            还没有生成录像文件。可以先用“演示全部”验证多路录像。
          </p>
        </section>

        <button
          class="ghost-button settings-open"
          type="button"
          @click="openSettings"
        >
          信号源设置（{{ cameras.length }} 路）
        </button>
      </aside>
    </main>

    <footer class="footer">
      <span>MEDIAMTX / WHEP</span>
      <span>EACH TILE RECORDS INDEPENDENTLY</span>
      <span class="mono">v0.2</span>
    </footer>

    <CameraSettings
      v-if="showSettings"
      :cameras="cameras"
      :focus-id="settingsFocusId"
      @close="closeSettings"
    />
  </div>
</template>
