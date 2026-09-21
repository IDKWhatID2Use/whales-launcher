#!/usr/bin/env node
/**
 * WhalesLauncher 宣传片 · 素材录制器（一键脚本）
 *
 * 设计前提（本机实测，见 docs/video/promo-plan-v1.md 3.2）：
 *   - 采集源用 ddagrab（GPU 桌面复制）—— 录的是 DWM 合成后的画面，Mica 观感不会丢；
 *   - 编码器用 h264_mf（系统 Media Foundation）—— 本机 ffmpeg 构建里 **没有 libx264**；
 *   - 所有子进程都用 stdio:'ignore' 或文件重定向，**不使用管道**（受限沙箱禁止带管道的 spawn）。
 *
 * 用法（项目根目录）：
 *   npm run rec:setup              环境自检（ffmpeg / 编码器 / 显示器 / 缩放 / 主题 / 目录）
 *   npm run rec -- list            列出 R1–R10 清单与逐段操作要点
 *   npm run rec -- R3              录 R3（3 秒倒数后自动开始，到点自动停）
 *   npm run rec -- R3 --take 3     连录 3 条备选
 *   npm run rec -- R8              全屏镜头（清单里已标 full，会自动全屏）
 *   npm run rec -- R3 --seconds 45 覆盖建议时长
 *   npm run rec -- guide           交互式依次录完 10 段
 *   npm run rec -- check           校验已录素材（分辨率 / 帧率 / 时长 / 掉帧）
 *
 * 环境变量：WHALES_FFMPEG / WHALES_FFPROBE 指定可执行文件路径。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT_DIR = join(ROOT, 'docs', 'video', 'project', '04_SCREEN')
const LOG_DIR = join(OUT_DIR, '_logs')

const FFMPEG = process.env.WHALES_FFMPEG || 'ffmpeg'
const FFPROBE = process.env.WHALES_FFPROBE || 'ffprobe'

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[36m' }
const ok = (s) => `${C.green}✔${C.reset} ${s}`
const bad = (s) => `${C.red}✘${C.reset} ${s}`
const warn = (s) => `${C.yellow}!${C.reset} ${s}`

/* ================================================================== *
 * R1–R10 录制清单（对应方案 3.2，S## 为分镜号）
 * ================================================================== */
const SHOTS = [
  {
    id: 'R0', slug: 'desktop-three-windows', shots: 'S01', mode: 'full',
    title: '桌面三实例窗口并排', seconds: 30,
    tips: [
      '先把三个「运行中」实例的窗口摆成品字形，窗口之间留出壁纸缝隙',
      '全屏录制：清空桌面图标、壁纸用系统自带冷调、任务栏保持默认',
      '录制期间不要 Alt+Tab、不要把鼠标停在任务栏图标上 —— 窗口的 OS 标题含上游字样，会以 tooltip 入镜',
      '鼠标最后缓慢横移一次即可，全程不点击',
    ],
    mask: '任务栏标签 / 悬停 tooltip 可能含上游名 → 后期遮蔽',
  },
  {
    id: 'R1', slug: 'instances-grid', shots: 'S03 / S04 / S17', mode: 'window',
    title: '主界面卡片网格（三实例）', seconds: 40,
    tips: [
      '开录前确认：三张实例卡，至少两个状态为「运行中」',
      '鼠标从左上缓慢移到右下，让三张卡依次进入视野，横穿一次约 4 秒，别快',
      '全程不点击，不新建、不删除，只让界面保持静止可读',
    ],
    mask: '页面副标题那行的 DSH_HOME 字样（首屏可见）→ 后期遮挡',
  },
  {
    id: 'R2', slug: 'wizard-4steps', shots: 'S05', mode: 'window',
    title: '创建向导四步', seconds: 60,
    tips: [
      '新建实例 → ①命名（demo-a）→ ②选引擎版本 → ③选模板 → ④定隔离范围',
      '每一步停 3 秒再点下一步，让剪辑有取镜余量；一次走完不回退',
    ],
    mask: '向导文案含 DSH_HOME → 后期遮挡',
  },
  {
    id: 'R3', slug: 'engines', shots: 'S06', mode: 'window',
    title: '引擎版本管理', seconds: 60,
    tips: [
      '版本管理页：已装列表停 5 秒 → 查询可安装版本 → 触发一次安装 → 看日志滚动',
      '日志区含上游包名的行由后期模糊，正常录即可，不用刻意躲',
      '若安装超过 40 秒，改为只演示「查询 + 已装列表」',
    ],
    mask: 'npm 安装日志里的上游包名 / node_modules 路径 → 后期模糊',
  },
  {
    id: 'R4', slug: 'plugins-settings', shots: 'S07', mode: 'window',
    title: '插件列表 + settings.yaml 编辑器', seconds: 60,
    tips: [
      '实例详情 → 插件页，拨动一次组合包开关（拨过去再拨回来）',
      '切到设置编辑器：光标定位、Ctrl+S 保存一次，让校验通过的反馈出现',
    ],
    mask: '详情页「DSH_HOME（home）」按钮 → 后期遮挡',
  },
  {
    id: 'R5', slug: 'isolation-switches', shots: 'S09', mode: 'window',
    title: '实例编辑 · 隔离开关', seconds: 45,
    tips: [
      '进实例编辑页，会话 / 设置 / 工作区三个开关各切换一次',
      '每次切换后停 2 秒再下一个，节奏均匀',
    ],
    mask: '无（该页文案不含上游字样）',
  },
  {
    id: 'R6', slug: 'saves', shots: 'S10', mode: 'window',
    title: '存档管理列表', seconds: 35,
    tips: ['详情页 → 存档，列表至少 3 行', '鼠标自上而下缓慢悬停两行，每行停 1.5 秒'],
    mask: '无',
  },
  {
    id: 'R7', slug: 'running-logs', shots: 'S12', mode: 'window',
    title: '运行中详情 + 日志端口行', seconds: 45,
    tips: [
      '先启动一个实例，等状态变成「运行中」再开录',
      '打开日志抽屉，滚动到出现监听端口那几行，停住 5 秒',
      '启动日志开头的命令行含上游路径，后期会裁掉那一行，正常录',
    ],
    mask: '启动日志开头的命令行（含引擎路径）→ 后期裁掉该行',
  },
  {
    id: 'R8', slug: 'window-mica', shots: 'S14', mode: 'full',
    title: '窗口特写（拖动 / 最大化 / 悬停关闭）', seconds: 40,
    tips: [
      '本段全屏录制：请先把本终端窗口拖到副屏，或按提示后最小化本窗口',
      '动作顺序：拖动标题栏移动窗口 → 双击标题栏最大化 → 还原 → 鼠标悬停关闭按钮停 0.8 秒',
      '全屏录制期间不要 Alt+Tab、不要把鼠标停在任务栏图标上（窗口的 OS 标题含上游字样，会以 tooltip 入镜）',
      '必须在普通桌面环境，受限沙箱里取不到 Mica 合成',
    ],
    mask: '自绘标题栏干净；但任务栏标签 / 悬停 tooltip 含上游名 → 后期遮蔽',
  },
  {
    id: 'R9', slug: 'global-settings', shots: 'S15', mode: 'window',
    title: '全局设置 + 应用内菜单', seconds: 45,
    tips: [
      '全局设置页：主题从「跟随系统」→ 深色 → 浅色，每次切换停 2 秒',
      '展开一次应用内菜单浮层后关闭',
    ],
    mask: '「主 home」一行若显示 .<上游名> 路径 → 后期遮挡',
  },
  {
    id: 'R10', slug: 'terminal-verify', shots: 'S16', mode: 'window', window: 'PowerShell',
    title: '终端：构建 / 测试 / 并发验收', seconds: 60,
    tips: [
      '在终端依次执行（用项目自带命令，不要现场改代码）：',
      '    npm run build',
      '    npm test',
      '    node tests/e2e/53-port-acceptance.mjs 8',
      '输出会被后期逐行检查，含上游字样的行模糊，正常跑即可',
      '窗口标题不是默认值时用：--window "Terminal"',
    ],
    mask: '测试文件名 / 断言信息里的上游字样 → 后期裁切或模糊',
  },
]

/* ================================================================== *
 * 基础工具（全部避免管道 stdio）
 * ================================================================== */
function ensureDirs() {
  for (const d of [OUT_DIR, LOG_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true })
}

/** 执行命令并把 stdout 重定向到临时文件（不使用 pipe） */
function runCapture(bin, args) {
  const tmp = join(tmpdir(), `wl-cap-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  const fd = openSync(tmp, 'w')
  const r = spawnSync(bin, args, { stdio: ['ignore', fd, 'ignore'] })
  closeSync(fd)
  let text = ''
  try { text = readFileSync(tmp, 'utf8') } catch { /* noop */ }
  try { unlinkSync(tmp) } catch { /* noop */ }
  return { status: r.status, error: r.error, text }
}

function hasBin(bin, probeArg = '-version') {
  const r = spawnSync(bin, [probeArg], { stdio: 'ignore' })
  return !r.error && r.status === 0
}

const psStr = (s) => `'${String(s).replace(/'/g, "''")}'`

/** 执行 PowerShell 脚本（结果写 JSON 文件再读回） */
function runPs(template, replacements) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const psFile = join(tmpdir(), `wl-${stamp}.ps1`)
  const outFile = join(tmpdir(), `wl-${stamp}.json`)
  let body = template.split('__OUT_PATH__').join(psStr(outFile))
  for (const [k, v] of Object.entries(replacements || {})) body = body.split(k).join(v)
  writeFileSync(psFile, body, 'utf8')
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { stdio: 'ignore' })
  let data = null
  try { data = JSON.parse(readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '')) } catch { /* noop */ }
  for (const f of [psFile, outFile]) { try { unlinkSync(f) } catch { /* noop */ } }
  return data
}

const PS_ENV_INFO = String.raw`
$Out = __OUT_PATH__
Add-Type -AssemblyName System.Windows.Forms
$screens = @()
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $screens += [pscustomobject]@{ device=$s.DeviceName; x=$s.Bounds.X; y=$s.Bounds.Y; w=$s.Bounds.Width; h=$s.Bounds.Height; primary=[bool]$s.Primary }
}
$dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI
if (-not $dpi) { $dpi = 96 }
$pers = Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction SilentlyContinue
$obj = [pscustomobject]@{
  screens = @($screens)
  dpi = [int]$dpi
  scalePercent = [int]([math]::Round($dpi / 96 * 100))
  appsLight = [int]$pers.AppsUseLightTheme
}
[IO.File]::WriteAllText($Out, (ConvertTo-Json -InputObject $obj -Compress -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
`

const PS_WINDOW_FINDER = String.raw`
$Out = __OUT_PATH__
$Title = __TITLE__
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class WLWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
'@
$script:found = New-Object System.Collections.ArrayList
$cb = [WLWin+EnumProc]{
  param($h, $l)
  if ([WLWin]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][WLWin]::GetWindowText($h, $sb, 512)
    $t = $sb.ToString()
    if ($t -and $t -like "*$Title*") {
      $r = New-Object WLWin+RECT
      [void][WLWin]::GetWindowRect($h, [ref]$r)
      [void]$script:found.Add([pscustomobject]@{ title=$t; x=$r.L; y=$r.T; w=($r.R-$r.L); h=($r.B-$r.T) })
    }
  }
  return $true
}
[void][WLWin]::EnumWindows($cb, [IntPtr]::Zero)
$json = if ($script:found.Count -gt 0) { ConvertTo-Json -InputObject @($script:found) -Compress } else { '[]' }
[IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
`

let envCache = null
function getEnvInfo(force = false) {
  if (!envCache || force) {
    const d = runPs(PS_ENV_INFO)
    if (d) {
      d.screens = Array.isArray(d.screens) ? d.screens : (d.screens ? [d.screens] : [])
      envCache = d
    }
  }
  return envCache
}

/** 系统窗口噪声：资源管理器、任务栏等 —— 否则「WhalesLauncher」会误命中同名文件夹窗口 */
const WINDOW_NOISE = /文件资源管理器|File Explorer|Program Manager|任务栏|Taskbar|Input Experience|Windows 输入体验/i

function findWindow(title) {
  const d = runPs(PS_WINDOW_FINDER, { __TITLE__: psStr(title) })
  const all = Array.isArray(d) ? d : (d ? [d] : [])
  const appLike = all.filter((w) => !WINDOW_NOISE.test(w.title) && w.w > 200 && w.h > 200)
  const esc = String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pref = new RegExp(`^\\s*${esc}\\s*[·—\\-]`)
  appLike.sort((a, b) => {
    const pa = pref.test(a.title) ? 1 : 0
    const pb = pref.test(b.title) ? 1 : 0
    if (pa !== pb) return pb - pa
    return b.w * b.h - a.w * a.h
  })
  return { all, appLike }
}

function fmtSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

let encCache = null
function pickEncoder(prefer) {
  if (prefer) return prefer
  if (encCache) return encCache
  encCache = encoderWorks('h264_mf') ? 'h264_mf' : 'libopenh264'
  return encCache
}

function encoderWorks(enc) {
  const out = join(tmpdir(), `wl-enc-${enc}-${Date.now()}.mp4`)
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'ddagrab=output_idx=0:framerate=30:video_size=320x240:offset_x=0:offset_y=0',
    '-vf', 'hwdownload,format=bgra', '-t', '0.2',
    '-c:v', enc, ...(enc === 'h264_mf' ? ['-rate_control', 'quality'] : []),
    '-pix_fmt', 'yuv420p', '-an', '-y', out,
  ]
  const r = spawnSync(FFMPEG, args, { stdio: 'ignore' })
  const good = !r.error && r.status === 0 && existsSync(out)
  try { unlinkSync(out) } catch { /* noop */ }
  return good
}

/** 把窗口的屏幕绝对坐标换算成「它所在显示器」的相对坐标，并对齐偶数 */
function locateOutput(x, y, w, h) {
  const info = getEnvInfo()
  const screens = info?.screens ?? []
  const cx = x + w / 2, cy = y + h / 2
  let idx = 0
  let scr = screens.find((s) => s.primary) || screens[0] || null
  screens.forEach((s, i) => {
    if (cx >= s.x && cx < s.x + s.w && cy >= s.y && cy < s.y + s.h) { scr = s; idx = i }
  })
  if (!scr) return { outIdx: 0, rect: { x: 0, y: 0, w: w - (w % 2), h: h - (h % 2) }, screen: null }
  let rx = Math.max(0, Math.min(Math.round(x - scr.x), scr.w - 2))
  let ry = Math.max(0, Math.min(Math.round(y - scr.y), scr.h - 2))
  let rw = Math.max(2, Math.min(Math.round(w), scr.w - rx))
  let rh = Math.max(2, Math.min(Math.round(h), scr.h - ry))
  rw -= rw % 2; rh -= rh % 2; rx -= rx % 2; ry -= ry % 2
  return { outIdx: idx, rect: { x: rx, y: ry, w: rw, h: rh }, screen: scr }
}

function buildArgs({ rect, outIdx, seconds, out, encoder, mouse }) {
  const src = `ddagrab=output_idx=${outIdx}:framerate=30:draw_mouse=${mouse ? 1 : 0}`
    + (rect ? `:video_size=${rect.w}x${rect.h}:offset_x=${rect.x}:offset_y=${rect.y}` : '')
  const enc = encoder === 'libopenh264'
    ? ['-c:v', 'libopenh264', '-b:v', '30M']
    : ['-c:v', 'h264_mf', '-b:v', '40M', '-rate_control', 'quality']
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', src,
    '-vf', 'hwdownload,format=bgra',
    '-t', String(seconds),
    ...enc,
    '-pix_fmt', 'yuv420p', '-an', '-y', out,
  ]
}

function probe(file) {
  const r = runCapture(FFPROBE, [
    '-hide_banner', '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,nb_frames',
    '-show_entries', 'format=duration', '-of', 'json', file,
  ])
  try {
    const j = JSON.parse(r.text)
    const s = j.streams?.[0] ?? {}
    const [num, den] = String(s.r_frame_rate || '0/1').split('/').map(Number)
    return {
      w: s.width, h: s.height,
      fps: den ? Math.round(num / den) : 0,
      frames: Number(s.nb_frames) || 0,
      duration: Number(j.format?.duration) || 0,
    }
  } catch { return null }
}

/* ================================================================== *
 * setup
 * ================================================================== */
function setup() {
  console.log(`${C.bold}WhalesLauncher 宣传片 · 录制环境自检${C.reset}\n`)
  let blocking = 0

  const ffOk = hasBin(FFMPEG), fpOk = hasBin(FFPROBE)
  console.log(ffOk ? ok(`ffmpeg 可用：${FFMPEG}`) : bad('ffmpeg 不可用 —— 用 WHALES_FFMPEG 指定 ffmpeg.exe'))
  console.log(fpOk ? ok(`ffprobe 可用：${FFPROBE}`) : bad('ffprobe 不可用 —— 用 WHALES_FFPROBE 指定'))
  if (!ffOk || !fpOk) blocking++

  if (ffOk) {
    const v = runCapture(FFMPEG, ['-hide_banner', '-version']).text.split('\n')[0].trim()
    console.log(`   ${C.dim}${v}${C.reset}`)
    const mf = encoderWorks('h264_mf'), oh = encoderWorks('libopenh264')
    console.log(mf ? ok('编码器 h264_mf 可用（Media Foundation，首选）') : warn('h264_mf 不可用'))
    console.log(oh ? ok('编码器 libopenh264 可用（软件备选）') : warn('libopenh264 不可用'))
    if (!mf && !oh) { console.log(bad('两种编码器都不可用 —— 无法录制')); blocking++ }
    const dda = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi',
      '-i', 'ddagrab=output_idx=0:framerate=30:video_size=320x240', '-t', '0.2', '-f', 'null', '-'], { stdio: 'ignore' })
    console.log(!dda.error && dda.status === 0
      ? ok('采集源 ddagrab 可用（GPU 桌面复制，能录到 Mica）')
      : warn('ddagrab 不可用 —— 需退回 gdigrab，Mica 观感可能丢失'))
  }

  const info = getEnvInfo(true)
  if (info?.screens?.length) {
    info.screens.forEach((s, i) => {
      console.log(ok(`显示器 #${i}  ${s.device}  ${s.w}×${s.h} @ (${s.x},${s.y})${s.primary ? '  [主屏]' : ''}`))
    })
    const max = Math.max(...info.screens.map((s) => s.w))
    console.log(max >= 1920
      ? `   ${C.dim}最宽 ${max}px，满足「原生像素录制」要求${C.reset}`
      : warn(`最宽仅 ${max}px —— 录出来的素材低于 1920，全屏镜头会不够用`))
  } else {
    console.log(warn('未能读取显示器信息（PowerShell 探测失败）'))
  }
  if (info) {
    console.log(info.scalePercent === 100
      ? ok('显示缩放 100% —— 符合录制要求')
      : warn(`显示缩放 ${info.scalePercent}% —— 请改回 100%（设置 → 系统 → 显示 → 缩放），否则像素对不上`))
    console.log(info.appsLight === 1
      ? warn('当前是浅色主题 —— 方案以深色为主（只有 S15 需要浅色），建议录制前切换')
      : ok('当前是深色主题 —— 符合方案主基调'))
  }

  ensureDirs()
  console.log(ok(`输出目录就绪：${OUT_DIR.replace(ROOT + '\\', '')}`))
  console.log(`   ${C.dim}日志目录：${LOG_DIR.replace(ROOT + '\\', '')}${C.reset}`)

  console.log(`\n${C.bold}脚本无法代劳、开录前请人工确认：${C.reset}`)
  console.log('  1. 通知 / 聚焦助手已关闭（否则录制中会弹横幅入镜）')
  console.log('  2. 应用窗口里没有无关标签、私人路径或临时文件名')
  console.log('  3. 素材实例已就绪（三张卡、至少两个「运行中」）')
  console.log(`\n${blocking === 0 ? ok('自检通过，可以开始录制') : bad(`有 ${blocking} 项阻塞问题，先修好`)}`)
  console.log(`${C.dim}下一步：npm run rec -- list${C.reset}`)
  return blocking === 0
}

/* ================================================================== *
 * list / check
 * ================================================================== */
function list() {
  console.log(`${C.bold}WhalesLauncher 宣传片 · 素材录制清单（R1–R10）${C.reset}\n`)
  for (const s of SHOTS) {
    const n = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => f.startsWith(`${s.id}_`)).length : 0
    const mark = n > 0 ? `${C.green}已录 ${n} 条${C.reset}` : `${C.dim}未录${C.reset}`
    console.log(`${C.bold}${s.id}${C.reset}  ${s.title}   ${C.dim}${s.shots} · ${s.mode === 'full' ? '全屏' : '窗口'} · 建议 ${s.seconds}s${C.reset}  [${mark}]`)
    for (const t of s.tips) console.log(`     ${t}`)
    if (s.mask && s.mask !== '无') console.log(`     ${C.yellow}后期：${s.mask}${C.reset}`)
    console.log('')
  }
  console.log(`${C.dim}录制：npm run rec -- R3    引导式全录：npm run rec -- guide    校验：npm run rec -- check${C.reset}`)
}

function check() {
  ensureDirs()
  const files = readdirSync(OUT_DIR).filter((f) => f.toLowerCase().endsWith('.mp4')).sort()
  if (!files.length) { console.log(warn('还没有录任何素材。先跑：npm run rec:setup')); return }
  console.log(`${C.bold}已录素材（${files.length} 个）${C.reset}\n`)
  const byShot = new Map()
  for (const f of files) {
    const full = join(OUT_DIR, f)
    const meta = probe(full)
    const size = fmtSize(statSync(full).size)
    const line = meta
      ? `${meta.w}×${meta.h}  ${meta.fps}fps  ${meta.duration.toFixed(1)}s  ${meta.frames} 帧  ${size}`
      : `（元数据读取失败）  ${size}`
    console.log(`  ${f}\n     ${C.dim}${line}${C.reset}`)
    const id = f.split('_')[0]
    byShot.set(id, (byShot.get(id) ?? 0) + 1)
  }
  console.log(`\n${C.bold}覆盖情况${C.reset}`)
  for (const s of SHOTS) {
    const n = byShot.get(s.id) ?? 0
    console.log(`  ${n > 0 ? `${C.green}✔${C.reset}` : `${C.red}✘${C.reset}`} ${s.id}  ${s.title}  ${C.dim}${n} 条${C.reset}`)
  }
  console.log(`\n${C.dim}方案要求每段至少 3 条备选：npm run rec -- R3 --take 3${C.reset}`)
}

/** 列出所有可见窗口，帮助确定 --window 关键词 */
function listWindows() {
  const { all } = findWindow('')
  const real = all.filter((w) => w.w > 200 && w.h > 200)
  if (!real.length) { console.log(warn('没有枚举到可见窗口')); return }
  console.log(`${C.bold}当前可见窗口（已滤掉 <200px 的隐藏/最小化窗口，共 ${real.length} 个）${C.reset}`)
  console.log(`${C.dim}用 --window "<关键词>" 定位；关键词取标题里够独特的一段。${C.reset}\n`)
  for (const w of real.slice().sort((a, b) => b.w * b.h - a.w * a.h)) {
    console.log(`  ${String(w.w).padStart(5)}×${String(w.h).padEnd(5)}  @(${w.x},${w.y})  ${w.title}`)
  }
}

/* ================================================================== *
 * 录制
 * ================================================================== */
async function recordOne(shot, opt, takeIndex = 1, takeTotal = 1) {
  ensureDirs()
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const suffix = takeTotal > 1 ? `_t${takeIndex}` : ''
  const file = join(OUT_DIR, `${shot.id}_${shot.slug}_${stamp}${suffix}.mp4`)
  const logFile = join(LOG_DIR, `${shot.id}_${stamp}${suffix}.log`)

  let rect = null
  let outIdx = opt.display ?? null

  if (opt.full || shot.mode === 'full') {
    console.log(`${C.blue}模式${C.reset} 全屏（主屏整体）`)
  } else if (opt.region) {
    const [x, y, w, h] = opt.region.split(',').map(Number)
    if ([x, y, w, h].some((v) => !Number.isFinite(v))) { console.log(bad('--region 需要 x,y,w,h 四个数字')); return null }
    const loc = locateOutput(x, y, w, h)
    rect = loc.rect; outIdx = opt.display ?? loc.outIdx
    console.log(`${C.blue}模式${C.reset} 指定区域 ${rect.w}×${rect.h} @ (${rect.x},${rect.y})（显示器 #${outIdx}）`)
  } else {
    const title = opt.window || shot.window || 'WhalesLauncher'
    const { all, appLike } = findWindow(title)
    if (!appLike.length) {
      if (all.length) console.log(bad(`只匹配到系统窗口（${all.map((w) => w.title).join(' / ')}）—— 应用似乎没启动；用 windows 命令看看有哪些窗口`))
      else console.log(bad(`没找到标题含「${title}」的可见窗口 —— 先启动应用，或用 --window / --region x,y,w,h / --full 指定`))
      return null
    }
    const w0 = appLike[0]
    const loc = locateOutput(w0.x, w0.y, w0.w, w0.h)
    rect = loc.rect; outIdx = opt.display ?? loc.outIdx
    console.log(`${C.blue}模式${C.reset} 窗口「${w0.title}」 → ${rect.w}×${rect.h} @ (${rect.x},${rect.y})（显示器 #${outIdx}）`)
  }
  if (outIdx === null) outIdx = 0

  const encoder = pickEncoder(opt.encoder)
  const seconds = opt.seconds || shot.seconds
  const args = buildArgs({ rect, outIdx, seconds, out: file, encoder, mouse: !opt.noMouse })

  console.log(`${C.blue}编码${C.reset} ${encoder}   ${C.blue}时长${C.reset} ${seconds}s   ${C.blue}输出${C.reset} ${file.replace(ROOT + '\\', '')}`)
  console.log(`\n${C.bold}${shot.id} · ${shot.title}${C.reset}`)
  for (const t of shot.tips) console.log(`  · ${t}`)
  if (shot.mask && shot.mask !== '无') console.log(`  ${C.yellow}· 后期：${shot.mask}${C.reset}`)
  console.log('')

  if (opt.dry) {
    console.log(warn('--dry 演练：不实际录制'))
    console.log(`${C.dim}${FFMPEG} ${args.join(' ')}${C.reset}`)
    return null
  }

  for (let i = 3; i > 0; i--) {
    process.stdout.write(`\r${C.yellow}${i} 秒后开始录制…${C.reset}   `)
    await new Promise((r) => setTimeout(r, 1000))
  }
  process.stdout.write('\r\x1b[K')

  const fd = openSync(logFile, 'w')
  const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', fd] })
  let killed = false
  const kill = () => { if (!killed) { killed = true; try { child.kill('SIGKILL') } catch { /* noop */ } } }
  const onSigint = () => { kill(); console.log(`\n${warn('已中断（Ctrl+C），产物可能不完整')}`) }
  process.on('SIGINT', onSigint)

  const t0 = Date.now()
  const timer = setInterval(() => {
    const left = Math.max(0, seconds - (Date.now() - t0) / 1000)
    process.stdout.write(`\r${C.red}● REC${C.reset} 剩余 ${left.toFixed(1)}s —— 现在去操作界面（本窗口按 Ctrl+C 可提前结束）   `)
  }, 100)

  await new Promise((res) => child.on('exit', res))
  clearInterval(timer)
  closeSync(fd)
  process.off('SIGINT', onSigint)
  process.stdout.write('\r\x1b[K')

  if (!existsSync(file)) {
    console.log(bad(`录制失败，日志：${logFile}`))
    try { console.log(readFileSync(logFile, 'utf8').split('\n').slice(0, 6).join('\n')) } catch { /* noop */ }
    return null
  }
  const meta = probe(file)
  const size = fmtSize(statSync(file).size)
  if (meta) {
    console.log(ok(`录好了  ${meta.w}×${meta.h}  ${meta.fps}fps  ${meta.duration.toFixed(2)}s  ${meta.frames} 帧  ${size}`))
    const drop = Math.round(meta.duration * meta.fps) - meta.frames
    if (drop > 3) console.log(warn(`比理想帧数少 ${drop} 帧 —— 若时长已达预期可忽略，否则重录一次`))
    if (meta.duration < seconds - 1.5) console.log(warn(`时长比设定短 ${(seconds - meta.duration).toFixed(1)}s —— 可能是提前中断`))
  } else {
    console.log(ok(`录好了  ${size}（ffprobe 读元数据失败，请手动确认）`))
  }
  return file
}

/* ================================================================== *
 * guide
 * ================================================================== */
async function guide() {
  ensureDirs()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log(`${C.bold}引导式录制：共 ${SHOTS.length} 段${C.reset}`)
  console.log(`${C.dim}每段开始前按 Enter；录制期间可自由切到应用操作，到点自动停。q=退出，s=跳过本段。${C.reset}\n`)
  for (const shot of SHOTS) {
    const a = await rl.question(`${C.bold}${shot.id} · ${shot.title}${C.reset}（${shot.shots}，${shot.seconds}s）— Enter 开始 / s 跳过 / q 退出：`)
    const t = a.trim().toLowerCase()
    if (t === 'q') break
    if (t === 's') { console.log(`${C.dim}已跳过${C.reset}\n`); continue }
    await recordOne(shot, {})
    console.log('')
  }
  rl.close()
  list()
}

/* ================================================================== *
 * CLI
 * ================================================================== */
function parseFlags(argv) {
  const o = {}
  const val = (i) => argv[i + 1]
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--full') o.full = true
    else if (a === '--dry') o.dry = true
    else if (a === '--no-mouse') o.noMouse = true
    else if (a === '--take') { o.take = Number(val(i)); i++ }
    else if (a.startsWith('--take=')) o.take = Number(a.slice(7))
    else if (a === '--seconds') { o.seconds = Number(val(i)); i++ }
    else if (a.startsWith('--seconds=')) o.seconds = Number(a.slice(10))
    else if (a === '--region') { o.region = val(i); i++ }
    else if (a.startsWith('--region=')) o.region = a.slice(9)
    else if (a === '--window') { o.window = val(i); i++ }
    else if (a.startsWith('--window=')) o.window = a.slice(9)
    else if (a === '--encoder') { o.encoder = val(i); i++ }
    else if (a.startsWith('--encoder=')) o.encoder = a.slice(10)
    else if (a === '--display') { o.display = Number(val(i)); i++ }
    else if (a.startsWith('--display=')) o.display = Number(a.slice(10))
  }
  return o
}

function help() {
  console.log(`${C.bold}WhalesLauncher 宣传片 · 素材录制器${C.reset}

  npm run rec:setup                环境自检（先跑这个）
  npm run rec -- list              清单与逐段操作要点
  npm run rec -- R3                录第 R3 段
  npm run rec -- R3 --take 3       连录 3 条备选
  npm run rec -- R3 --dry          只演练参数，不真录
  npm run rec -- guide             交互式依次录完 10 段
  npm run rec -- check             校验已录素材
  npm run rec -- windows           列出当前可见窗口（用来确定 --window 关键词）

可选参数：
  --seconds <n>        覆盖建议时长
  --take <n>           连录 n 条
  --region x,y,w,h     手动指定区域（屏幕绝对坐标，用 --dry 先看换算结果）
  --window <关键词>     按窗口标题定位（默认 WhalesLauncher）
  --full               强制全屏
  --display <n>        指定输出显示器序号（0=主屏）
  --encoder <name>     h264_mf | libopenh264
  --no-mouse           不录鼠标指针
  --dry                只打印参数

环境变量：WHALES_FFMPEG / WHALES_FFPROBE 指定可执行文件路径。`)
}

const [cmd, ...rest] = process.argv.slice(2)
const opt = parseFlags(rest)
const findShot = (v) => SHOTS.find((s) => s.id === String(v || '').toUpperCase())

switch (cmd) {
  case 'setup': setup(); break
  case 'list': list(); break
  case 'check': check(); break
  case 'windows': listWindows(); break
  case 'guide': await guide(); break
  case 'run': {
    const shot = findShot(rest[0])
    if (!shot) { console.log(bad(`没有这一段：${rest[0]}`)); break }
    const take = opt.take || 1
    for (let i = 1; i <= take; i++) await recordOne(shot, opt, i, take)
    break
  }
  case undefined:
  case 'help':
  case '--help': help(); break
  default: {
    const shot = findShot(cmd)
    if (!shot) { console.log(bad(`未知命令：${cmd}\n`)); help(); break }
    const take = opt.take || 1
    for (let i = 1; i <= take; i++) await recordOne(shot, opt, i, take)
  }
}
