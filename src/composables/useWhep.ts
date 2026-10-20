import { onScopeDispose, ref, shallowRef } from 'vue'

export type WhepState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'

/**
 * Minimal WHEP client for MediaMTX / go2rtc.
 * The recorder never sees RTSP; it records the WebRTC MediaStream.
 */
export function useWhep() {
  const stream = shallowRef<MediaStream>()
  const state = ref<WhepState>('idle')
  const error = ref<string | null>(null)

  let endpoint = ''
  let pc: RTCPeerConnection | null = null
  let stopped = true
  let retry = 0
  let retryTimer: number | undefined
  let disconnectTimer: number | undefined
  let generation = 0

  function closePeer() {
    if (disconnectTimer !== undefined) {
      window.clearTimeout(disconnectTimer)
      disconnectTimer = undefined
    }
    if (pc) {
      pc.onconnectionstatechange = null
      pc.close()
      pc = null
    }
  }

  async function open() {
    const gen = ++generation
    closePeer()
    state.value = retry > 0 ? 'reconnecting' : 'connecting'
    error.value = null

    const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle' })
    pc = peer

    const remote = new MediaStream()
    peer.ontrack = (event) => {
      remote.addTrack(event.track)
      if (gen === generation) stream.value = remote
    }

    peer.addTransceiver('video', { direction: 'recvonly' })
    peer.addTransceiver('audio', { direction: 'recvonly' })

    peer.onconnectionstatechange = () => {
      if (gen !== generation) return

      if (peer.connectionState === 'connected') {
        state.value = 'connected'
        retry = 0
        return
      }

      if (peer.connectionState === 'failed') {
        scheduleReconnect()
      } else if (peer.connectionState === 'disconnected') {
        if (disconnectTimer !== undefined) {
          window.clearTimeout(disconnectTimer)
        }
        disconnectTimer = window.setTimeout(() => {
          if (peer.connectionState === 'disconnected') scheduleReconnect()
        }, 5000)
      }
    }

    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10_000)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offer.sdp,
        signal: controller.signal,
      })
    } finally {
      window.clearTimeout(timeout)
    }

    if (gen !== generation) {
      peer.close()
      return
    }

    if (!response.ok) {
      throw new Error(`WHEP ${response.status}: ${await response.text()}`)
    }

    await peer.setRemoteDescription({
      type: 'answer',
      sdp: await response.text(),
    })
  }

  function scheduleReconnect() {
    if (stopped || retryTimer !== undefined) return
    state.value = 'reconnecting'
    const delay = Math.min(1000 * 2 ** retry, 10_000)
    retry += 1
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined
      open().catch((e) => {
        error.value = String(e)
        scheduleReconnect()
      })
    }, delay)
  }

  function start(url: string) {
    endpoint = url.trim()
    if (!endpoint) {
      state.value = 'failed'
      error.value = '请填写 WHEP 地址'
      return
    }
    if (!stopped) return
    stopped = false
    retry = 0
    open().catch((e) => {
      error.value = String(e)
      scheduleReconnect()
    })
  }

  function stop() {
    stopped = true
    generation += 1
    if (retryTimer !== undefined) {
      window.clearTimeout(retryTimer)
      retryTimer = undefined
    }
    closePeer()
    stream.value = undefined
    state.value = 'idle'
  }

  onScopeDispose(stop)

  return { start, stop, stream, state, error }
}
