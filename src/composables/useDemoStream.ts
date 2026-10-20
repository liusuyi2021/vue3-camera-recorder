import { onScopeDispose, shallowRef } from 'vue'

/**
 * Synthetic camera signal for testing the recorder without a camera or gateway.
 * It has a real video track and a real audio track, so MediaRecorder behaves
 * like it does with the camera.
 */
export function useDemoStream() {
  const stream = shallowRef<MediaStream>()

  let canvas: HTMLCanvasElement | null = null
  let raf = 0
  let audioContext: AudioContext | null = null
  let oscillator: OscillatorNode | null = null

  function stop() {
    cancelAnimationFrame(raf)
    raf = 0
    oscillator?.stop()
    oscillator = null
    void audioContext?.close()
    audioContext = null
    stream.value?.getTracks().forEach((track) => track.stop())
    stream.value = undefined
    canvas = null
  }

  function start(label = 'DEMO') {
    stop()

    let hash = 0
    for (let i = 0; i < label.length; i += 1) {
      hash = (hash * 31 + label.charCodeAt(i)) >>> 0
    }
    const hue = hash % 360
    const accent = `hsl(${hue} 72% 54%)`

    const c = document.createElement('canvas')
    c.width = 1280
    c.height = 720
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D 不可用')
    canvas = c

    const started = Date.now()
    const draw = () => {
      if (!canvas) return
      const w = canvas.width
      const h = canvas.height
      const t = (Date.now() - started) / 1000

      ctx.fillStyle = '#0d151c'
      ctx.fillRect(0, 0, w, h)

      ctx.strokeStyle = 'rgba(220, 235, 245, 0.09)'
      ctx.lineWidth = 1
      for (let x = 0; x < w; x += 64) {
        ctx.beginPath()
        ctx.moveTo(x + 0.5, 0)
        ctx.lineTo(x + 0.5, h)
        ctx.stroke()
      }
      for (let y = 0; y < h; y += 64) {
        ctx.beginPath()
        ctx.moveTo(0, y + 0.5)
        ctx.lineTo(w, y + 0.5)
        ctx.stroke()
      }

      const x = (w / 2) + Math.sin(t * 0.9) * (w * 0.3)
      const y = (h / 2) + Math.cos(t * 0.7) * (h * 0.18)
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.arc(x, y, 18, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = `hsl(${hue} 72% 54% / 0.18)`
      ctx.beginPath()
      ctx.arc(x, y, 54 + Math.sin(t * 3) * 6, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = '#eef4f6'
      ctx.font = '500 22px "IBM Plex Mono", monospace'
      ctx.fillText(`${label} / DEMO / 1280 x 720 / 30 fps`, 42, 62)

      ctx.font = '500 64px "IBM Plex Mono", monospace'
      ctx.fillText(new Date().toLocaleTimeString('zh-CN'), 42, h - 58)

      ctx.fillStyle = 'rgba(238, 244, 246, 0.55)'
      ctx.font = '400 18px "IBM Plex Mono", monospace'
      ctx.fillText(`T+${t.toFixed(1)}s`, w - 190, h - 58)

      raf = requestAnimationFrame(draw)
    }
    draw()

    const videoStream = c.captureStream(30)
    const ac = new AudioContext()
    const destination = ac.createMediaStreamDestination()
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = 300 + (hash % 300)
    gain.gain.value = 0.035
    osc.connect(gain).connect(destination)
    osc.start()

    audioContext = ac
    oscillator = osc
    stream.value = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ])
  }

  onScopeDispose(stop)

  return { start, stop, stream }
}
