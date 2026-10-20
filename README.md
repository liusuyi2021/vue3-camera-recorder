# Vue3 多路本地录像宫格

> 在浏览器里同时预览、分段录制多路相机。每格独立录像，文件直接写入本地目录，不需要把录像上传到服务器。

[![Vue 3](https://img.shields.io/badge/Vue-3-42b883?logo=vue.js&logoColor=white)](https://vuejs.org/)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 界面预览

| 2×2 宫格 | 3×3 宫格 |
| --- | --- |
| ![2×2 宫格](docs/screenshots/2x2.png) | ![3×3 宫格](docs/screenshots/3x3.png) |

## 为什么做这个项目

很多相机 Web 控制台的“本地录像”依赖厂商插件、ActiveX 或本地服务，难以嵌入现代 Vue 项目，也不适合多路同时录制。

这个项目把链路拆成两部分：

- **MediaMTX / go2rtc** 只负责把相机 RTSP 转成浏览器可用的 WebRTC；
- **Vue3 前端** 负责每格的 WebRTC 连接、`MediaRecorder` 编码、分段和本地文件写入。

因此录像过程完全在浏览器里完成，网关不落盘，也不参与录像。

## 功能

- 2×2 / 3×3 宫格，最多 9 路同时预览。
- 每格独立 WHEP 地址、独立连接、独立开始/停止录像。
- 全局“全部连接 / 全部录像 / 全部停止 / 全部断开”。
- 9 路共用一次选择的保存目录，文件名自动使用 `cam01`…`cam09` 前缀。
- 每 1 秒切 chunk，5 分钟自动分段，每段独立视频文件（默认优先 MP4，失败回退 WebM）。
- 分段结束时补写 MP4 总时长（`mvhd` / `tkhd` / `mdhd`）。
- 自动处理并发录制时首块 `moov` 不完整的问题。
- 每路可开启 720p 兼容模式，降低多路同时重编码的 CPU 压力。
- 没有相机时可用“演示全部”验证完整链路。
- 信号源配置和宫格布局保存在本机 `localStorage`。
- HTTPS 开发模式开箱可用（自签名证书）。

## 架构

```mermaid
flowchart LR
  C1["Camera 01 RTSP"] --> M["MediaMTX / go2rtc"]
  C2["Camera 02 RTSP"] --> M
  C3["Camera 0N RTSP"] --> M
  M -->|"WHEP"| A["Vue3 Grid"]
  A --> T1["Tile 01"]
  A --> T2["Tile 02"]
  T1 --> R1["MediaRecorder"]
  T2 --> R2["MediaRecorder"]
  R1 --> S[("Shared save directory")]
  R2 --> S
```

核心原则：

1. 浏览器不能直接播放 RTSP，所以需要 WHEP 网关。
2. 网关只转发 WebRTC，不写文件。
3. 每个宫格拥有自己的 `RTCPeerConnection` 和 `MediaRecorder`。
4. 所有宫格共用一个目录写入权限，但每个文件独立命名、独立分段、独立补写时长。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | 20.19+ / 22.12+ / 24 |
| 浏览器 | Chrome / Edge 102+ 推荐 |
| 流媒体网关 | MediaMTX 或 go2rtc，支持 WHEP |
| 相机编码 | H.264 最稳；H.265 取决于浏览器和网关 |
| 目录写盘 | HTTPS 或 localhost，顶层窗口 |

浏览器能力概览：

| 能力 | Chrome / Edge | Safari | Firefox |
| --- | --- | --- | --- |
| WebRTC / WHEP | ✅ | ✅ | ✅ |
| MediaRecorder MP4 | 取决于版本 | ✅ | 部分支持 |
| 目录写盘（File System Access） | ✅ | ❌ | ❌ |
| 推荐程度 | 推荐 | 仅预览/下载 | 不推荐 |

## 快速开始

```bash
git clone https://github.com/YOUR_GITHUB_NAME/vue3-camera-recorder.git
cd vue3-camera-recorder
npm install
npm run dev:https
```

打开：

```text
https://localhost:5173
```

局域网访问时使用运行项目的机器 IP，例如：

```text
https://192.168.1.50:5173
```

自签名证书会触发浏览器警告，选择“继续访问”即可。生产环境请使用 Caddy / nginx 配真实证书。

普通 HTTP 模式：

```bash
npm run dev
```

HTTP 下仍然可以录像，但浏览器会禁用目录写盘 API，只能按段下载。

## 配置 MediaMTX

仓库提供了：

- `mediamtx.example.yml`：4 路示例，注释里有 9 路模板
- `docker-compose.yml`：MediaMTX 容器

先修改 `mediamtx.example.yml`：

```yaml
webrtcAdditionalHosts: [192.168.1.50]  # 改成网关所在机器的局域网 IP

paths:
  cam01:
    source: rtsp://viewer:CHANGE_ME@192.168.1.101:554/Streaming/Channels/102
    rtspTransport: tcp
    sourceOnDemand: yes

  cam02:
    source: rtsp://viewer:CHANGE_ME@192.168.1.102:554/Streaming/Channels/102
    rtspTransport: tcp
    sourceOnDemand: yes
```

启动：

```bash
docker compose up -d
```

或者直接运行 MediaMTX 二进制：

```bash
mediamtx mediamtx.example.yml
```

路径和 WHEP 地址的对应关系：

| MediaMTX path | 播放页 | 项目里填写的 WHEP |
| --- | --- | --- |
| `cam01` | `https://GATEWAY:8889/cam01` | `https://GATEWAY:8889/cam01/whep` |
| `cam02` | `https://GATEWAY:8889/cam02` | `https://GATEWAY:8889/cam02/whep` |

注意：

- `GATEWAY` 换成浏览器能访问到的网关 IP 或域名；
- WebRTC 需要放行 UDP `8189`；
- 如果网关和浏览器不在同一网段，确保 ICE 候选地址可达；
- 多路的前提是 MediaMTX 里配置多个 path，每个 path 对应一台相机；
- 9 格填同一个 WHEP 地址只会显示同一路流。

## 配置信号源

1. 打开页面右侧 **“信号源设置（9 路）”**。
2. 给每格填写名称和 WHEP 地址。
3. 2×2 使用前 4 路，3×3 使用全部 9 路。
4. 修改会自动保存到本机 `localStorage`，刷新页面不会丢。

可选：用环境变量给 CAM 01 一个默认地址：

```bash
# .env.local
VITE_WHEP_URL=https://gateway.example.com:8889/cam01/whep
```

> WHEP 路径可能包含临时 token，属于敏感信息。不要把含 token 的地址提交到 Git，也不要在公开截图里暴露。

## 使用

### 单格操作

| 控件 | 作用 |
| --- | --- |
| `连接` | 连接该格配置的 WHEP 地址 |
| `演示` | 启动本地合成信号，不需要相机 |
| `REC` / `STOP` | 只控制这一格录像 |
| `MUTE` / `SOUND` | 预览声音，不影响录像音轨 |
| `FULL` | 将该格全屏 |
| `SET` | 定位到该格的信号源配置 |
| `SAVE` | 下载回退时，手动重存最近一段 |

### 全局操作

| 按钮 | 作用 |
| --- | --- |
| `全部连接` | 连接当前可见的所有宫格 |
| `全部录像` | 启动当前可见宫格；未连接的会先尝试连接 |
| `全部停止` | 停止并收尾所有录制中的宫格 |
| `全部断开` | 停止录像并断开所有连接 |
| `演示全部` | 给当前可见宫格启动演示信号 |

3×3 切回 2×2 时，如果正在录像会弹出确认，因为隐藏的宫格会被停止并卸载。

## 保存目录

目录写盘需要同时满足：

- 页面是 HTTPS 或 `localhost`；
- 浏览器是 Chrome / Edge 86+；
- 页面在顶层窗口，不是跨域 iframe。

页面右侧的 `SECURE / FS API / TOP` 三个标记会显示当前能力，三个都绿时“选择目录”可用。

选择一次目录后，所有宫格共用。文件示例：

```text
cam01-20261020-111412397-001.mp4
cam02-20261020-111412397-001.mp4
...
cam09-20261020-111412397-001.mp4
```

未选择目录时，每路会按段下载。Chrome 第一次连续下载多个文件时会询问“允许此网站下载多个文件”；如果被拦截，用每格的 `SAVE` 手动保存最近一段。

## 实现细节

### 取流

每个 `CameraTile` 创建自己的 `RTCPeerConnection`，通过 WHEP `POST application/sdp` 接收 MediaMTX 的 SDP answer。断线时按指数退避重连。

### 录像

- `MediaRecorder.start(1000)`：每秒产生一个 chunk；
- 每个分段独立创建 `MediaRecorder`；
- 达到分段长度后停止当前 recorder，关闭文件，再开始下一段；
- 分段计时统一使用 `performance.now()`，文件时间戳使用墙钟时间。

### 写盘

优先使用 File System Access API：

- 用户选择一个目录；
- 每个分段创建独立文件；
- chunk 到达后立即写入，不在内存里累积整段视频。

不支持目录写盘时：

- 每个分段在内存中累积；
- 分段结束后触发下载；
- 最近一段保留 `SAVE` 入口。

### MP4 总时长修复

`MediaRecorder` 写出的 MP4 是 fragmented MP4，`mvhd.duration` 通常是 `0`。这会导致：

- 播放器显示不出总时长；
- 文件列表和播放器显示不一致；
- 部分播放器的时长显示和 seek 行为不一致；VLC 右侧递减通常是“剩余时间”显示模式。

项目在分段结束时：

1. 累积前几个 chunk，直到拿到完整的 `moov`；
2. 补写 `mvhd`、`tkhd`、`mdhd` 的 duration；
3. 目录写盘时用 `seek(0)` 回写文件头；
4. 下载回退时直接替换第一个 MP4 chunk。

> 录制中的文件会先出现在目标目录里，但还没有收尾。**停止录像或等待分段切换后再打开文件**。

旧文件或某些播放器仍不认 fragmented MP4 时，可以无损转封装成标准 MP4：

```bash
ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4
```

### 兼容模式

勾选“兼容模式（每路 720p 重绘）”后，每格会把视频元素重绘到 1280×720 canvas，再录制 canvas 流。适合：

- 4MP / 4K 相机；
- 多路同时录制导致 CPU 过高；
- 浏览器编码器拒绝原始分辨率。

兼容模式会损失一部分分辨率，但显著降低编码压力。

## 性能建议

多路同时录制时，瓶颈通常是 **浏览器编码器**，不是网络。

- 优先使用相机子码流 `102`（704×576）或 `103`（720p）；
- 不建议 4 路以上同时使用 3072×2048 主码流；
- 每路码率从 2 Mbps 起步；
- 4 路以上建议开启兼容模式；
- 分段长度 5 分钟比较均衡；
- 9 路 1080p 需要在实际机器上做 1 小时压测；
- 磁盘空间按“每路码率 × 路数 × 时长”估算。

## 常见问题

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 提示“当前浏览器不支持目录写盘” | HTTP 页面、Firefox/Safari、跨域 iframe | 用 HTTPS/localhost + Chrome/Edge 顶层窗口 |
| `EncodingError: The given encoder configuration is not supported` | MIME 参数过细或分辨率过高 | 使用 `video/mp4`、切 WebM、开兼容模式、用子码流 |
| 文件没有总时长 | 录制中的文件还没收尾，或旧文件在修复前生成 | 停止/分段结束后再打开；旧文件用 ffmpeg 转封装 |
| VLC 右侧时间递减 | VLC 显示的是剩余时间，不是总时长 | 点击 VLC 时间显示切换；用 ffprobe 确认固定 duration |
| 多路同时下载被拦截 | 浏览器限制多文件自动下载 | 选择目录写盘；或用每格 `SAVE` 手动保存 |
| 连接失败 / 无画面 | WHEP 地址、MediaMTX path、证书或 CORS | 先打开播放页确认；检查路径是否以 `/whep` 结尾 |
| 9 路同时录像卡顿 | CPU 编码压力过大 | 子码流、2 Mbps、兼容模式、减少路数 |

### 用 ffprobe 检查文件

```bash
ffprobe -v error -show_entries format=duration -of default=nw=1 "your-file.mp4"
```

输出的 duration 应该是固定值，不会随播放变化。

## 项目结构

```text
.
├── docs/
│   └── screenshots/
│       ├── 2x2.png
│       └── 3x3.png
├── public/
│   └── favicon.svg
├── src/
│   ├── components/
│   │   ├── CameraSettings.vue
│   │   └── CameraTile.vue
│   ├── composables/
│   │   ├── useDemoStream.ts
│   │   ├── useSegmentedRecorder.ts
│   │   └── useWhep.ts
│   ├── types/
│   │   ├── camera.ts
│   │   └── recorder.ts
│   ├── utils/
│   │   ├── compatStream.ts
│   │   └── mp4Duration.ts
│   ├── App.vue
│   ├── main.ts
│   └── style.css
├── docker-compose.yml
├── mediamtx.example.yml
├── package.json
└── vite.config.ts
```

## 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | HTTP 开发模式 |
| `npm run dev:https` | HTTPS 开发模式（目录写盘需要） |
| `npm run typecheck` | TypeScript / Vue 类型检查 |
| `npm run build` | 类型检查并构建生产包 |
| `npm run preview` | 预览生产构建 |

## 验证情况

已完成：

- 4 路同时演示 + 同时录像，生成 4 个独立 MP4；
- 9 路同时演示 + 同时录像，生成 `cam01`…`cam09` 共 9 个独立 MP4；
- 每路文件头独立写入 `mvhd.duration`；
- 真实 1920×1080 WHEP 流录制、时长补写正常；
- 信号源配置持久化、按格定位正常；
- `npm run typecheck` 和 `npm run build` 通过。

9 路并发验证使用本地演示信号，验证的是连接、独立编码、分段、落盘和时长补写链路；真实 9 路 1080p 的 CPU、内存和带宽仍需按部署硬件压测。

## 安全

- 给相机建立只读账号，不要把 `admin` 密码写进前端。
- 相机凭据只放在 MediaMTX 配置里。
- 给 WHEP 端点加反向代理认证或内网访问控制。
- 不要把相机的 `80 / 554 / 7681` 端口直接暴露到公网。
- WHEP 地址和 token 会保存在浏览器 `localStorage`；公共电脑上使用后请清理站点数据。
- 本项目不自带登录鉴权，生产部署必须自行保护页面和网关。

## 已知限制

- 录制依赖浏览器标签页保持打开；关闭页面会停止录像。
- 异常退出或断电最多丢失当前分段的收尾部分。
- 目录写盘仅支持 Chromium 系浏览器；其他浏览器走下载回退。
- 目录句柄不会跨页面刷新持久化，每次会话需要重新选择目录。
- `MediaRecorder` 输出 fragmented MP4；项目会补写时长，但部分老播放器仍可能更喜欢标准 MP4。
- 9 路 4K/4MP 主码流同时录制对普通电脑压力很大。
- 没有内置回放、用户权限、服务端存储和远程管理。

## Roadmap

- [ ] 用 WebCodecs + mp4-muxer 直接输出标准 progressive MP4
- [ ] 把目录句柄持久化到 IndexedDB
- [ ] 每格独立的码率/格式/分段设置
- [ ] 内置录像回放与按摄像头筛选
- [ ] 服务端录制可选方案（MediaMTX + ffmpeg）
- [ ] 英文界面 / i18n
- [ ] 更多网关示例（go2rtc、Frigate、ONVIF）

## 贡献

欢迎 Issue 和 PR。提交前请：

```bash
npm run typecheck
npm run build
```

UI 改动请附截图；不要在 Issue、截图或提交里包含真实相机密码、WHEP token、内网地址或录像文件。

提交信息建议使用 Conventional Commits，例如：

```text
feat: add 3x3 grid layout
fix: repair mp4 duration on concurrent segments
docs: improve mediamtx setup
```

## License

[MIT](LICENSE)

如果这个项目对你有帮助，欢迎 Star 或提交改进。

## 致谢

- [MediaMTX](https://github.com/bluenviron/mediamtx) — RTSP → WebRTC 网关
- [Vue 3](https://vuejs.org/) / [Vite](https://vite.dev/) / [TypeScript](https://www.typescriptlang.org/)
- [Fontsource](https://fontsource.org/) — Archivo / IBM Plex Mono
