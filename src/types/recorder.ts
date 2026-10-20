export type WritableLike = {
  write(data: Blob): Promise<void>
  close(): Promise<void>
  seek?(position: number): Promise<void>
}

export type FileHandleLike = {
  createWritable(): Promise<WritableLike>
}

export type DirectoryHandleLike = {
  name: string
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileHandleLike>
}

export type SegmentInfo = {
  name: string
  size: number
  durationMs: number
  at: number
  storage: 'disk' | 'download'
}
