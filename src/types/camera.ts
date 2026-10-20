import type { SegmentInfo } from './recorder'

export type CameraConfig = {
  id: string
  name: string
  url: string
}

export type TileUpdate = {
  id: string
  name: string
  connected: boolean
  recording: boolean
  startedAt: number | null
  files: SegmentInfo[]
  error: string | null
}
