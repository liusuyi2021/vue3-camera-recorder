export type CompatStreamHandle = {
  stream: MediaStream
  stop: () => void
}

/**
 * 兼容模式：把当前视频元素重绘到 720p canvas 再录制。
 * 用于 4MP/4K 或浏览器编码器拒绝原始分辨率的情况。
 */
export function createCompatStream(
  video: HTMLVideoElement,
  source: MediaStream,
  width = 1280,
  height = 720,
): CompatStreamHandle {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D 不可用')

  let raf = 0
  const draw = () => {
    if (video.readyState >= 2) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
    }
    raf = requestAnimationFrame(draw)
  }
  draw()

  const canvasStream = canvas.captureStream(25)
  const output = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...source.getAudioTracks(),
  ])

  function stop() {
    cancelAnimationFrame(raf)
    raf = 0
    canvasStream.getTracks().forEach((track) => track.stop())
    output.getVideoTracks().forEach((track) => track.stop())
  }

  return { stream: output, stop }
}
