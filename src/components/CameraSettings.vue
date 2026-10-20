<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted } from 'vue'
import type { CameraConfig } from '../types/camera'

const props = defineProps<{
  cameras: CameraConfig[]
  focusId?: string | null
}>()

const emit = defineEmits<{
  (event: 'close'): void
}>()

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  if (!props.focusId) return
  await nextTick()
  const input = document.getElementById(`camera-url-${props.focusId}`)
  input?.scrollIntoView({ block: 'center' })
  input?.focus()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function pad(value: number) {
  return String(value).padStart(2, '0')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section
      class="modal-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <header class="modal-head">
        <div>
          <p class="eyebrow">SIGNAL SOURCES</p>
          <h2 id="settings-title">多路信号源</h2>
        </div>
        <button class="ghost-button small" type="button" @click="emit('close')">
          关闭
        </button>
      </header>

      <p class="hint">
        每路填一个 MediaMTX WHEP 地址，通常以 <code>/whep</code> 结尾。
        修改会自动保存到本机浏览器。
      </p>

      <div class="settings-list">
        <div
          v-for="(camera, index) in cameras"
          :key="camera.id"
          class="settings-row"
        >
          <span class="settings-index mono">{{ pad(index + 1) }}</span>
          <label class="field settings-name">
            <span>名称</span>
            <input v-model="camera.name" type="text" maxlength="24" />
          </label>
          <label class="field settings-url">
            <span>WHEP 地址</span>
            <input
              :id="`camera-url-${camera.id}`"
              v-model="camera.url"
              type="url"
              spellcheck="false"
              placeholder="https://host:8889/path/whep"
            />
          </label>
        </div>
      </div>

      <footer class="modal-foot">
        <span class="hint">2×2 使用前 4 路，3×3 使用全部 9 路。</span>
        <button class="primary-button" type="button" @click="emit('close')">
          完成
        </button>
      </footer>
    </section>
  </div>
</template>
