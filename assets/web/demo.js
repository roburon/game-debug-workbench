const { createPreviewClock, mountWorkbench } = GameDebugWorkbench
const locale = GameDebugWorkbench.resolveLocale()
const t = (ja, en) => locale === 'ja' ? ja : en
document.documentElement.lang = locale
document.title = t('ゲームの調整とデバッグ', 'Game tuning and debugging')
document.querySelector('h1').textContent = document.title
document.querySelector('nav').setAttribute('aria-label', t('見本の切り替え', 'Choose a demo'))
document.querySelector('nav [aria-current]').textContent = t('ボールの反発', 'Bouncing ball')
document.querySelector('nav a').textContent = t('3レーンの配達', 'Three-lane delivery')
const preview = document.querySelector('.preview')
const canvas = preview.querySelector('canvas')
const playHint = preview.querySelector('[data-play-hint]')
canvas.setAttribute('aria-label', t('跳ねるボールのプレビュー', 'Bouncing ball preview'))
playHint.textContent = t('タップまたは Space で跳ね上げる', 'Tap or press Space to boost the ball')
const ctx = canvas.getContext('2d')
const debug = new URLSearchParams(location.search).get('debug') !== '0'
const floor = 386
let gravity = 360
let elasticity = 0.7
let x, y, vx, vy, bounces
let seed = 271828
let workbench

function ballState() {
  return { x, y, vx, vy, bounces, seed }
}

function restoreBall(state) {
  ({ x, y, vx, vy, bounces, seed } = state)
}

function validBall(state) {
  return state && ['x', 'y', 'vx', 'vy', 'bounces', 'seed'].every(key => Number.isFinite(state[key])) &&
    state.x >= 24 && state.x <= 296 && state.y >= -10000 && state.y <= floor &&
    Math.abs(state.vx) <= 10000 && Math.abs(state.vy) <= 10000 &&
    Number.isSafeInteger(state.bounces) && state.bounces >= 0 &&
    Number.isInteger(state.seed) && state.seed >= 0 && state.seed <= 0xffffffff
}

function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 0x100000000
}

const clock = createPreviewClock(debug ? {
  history: { capture: ballState, restore: restoreBall },
} : undefined)

function reset() {
  restoreBall({ x: 85, y: 70, vx: 95, vy: 0, bounces: 0, seed: 271828 })
}

function applyInput(input) {
  if (input?.type !== 'boost') throw new TypeError(t('未対応のボール操作です', 'Unsupported ball input'))
  vy = -270
  vx = (vx < 0 ? -1 : 1) * (70 + random() * 60)
  workbench?.notifyEvent('boost')
}

function boost() {
  if (workbench) return workbench.input({ type: 'boost' })
  applyInput({ type: 'boost' })
}

function update(dt) {
  x += vx * dt
  const nextX = Math.max(24, Math.min(296, x))
  if (nextX !== x) {
    vx = -vx
    workbench?.notifyEvent('wall')
  }
  x = nextX
  vy += gravity * dt
  y += vy * dt
  if (y >= floor) {
    y = floor
    if (vy > 18) {
      vy = -vy * elasticity
      bounces += 1
      workbench?.notifyEvent('floor')
    } else {
      vy = 0
    }
  }
}

function render() {
  ctx.fillStyle = '#112820'
  ctx.fillRect(0, 0, 320, 440)
  ctx.strokeStyle = '#1c4337'
  ctx.beginPath()
  for (let column = 16; column < 320; column += 24) {
    ctx.moveTo(column, 20)
    ctx.lineTo(column, 413)
  }
  for (let row = 29; row < 413; row += 24) {
    ctx.moveTo(16, row)
    ctx.lineTo(304, row)
  }
  ctx.stroke()
  ctx.fillStyle = '#244e3e'
  ctx.fillRect(16, floor + 15, 288, 22)
  ctx.strokeStyle = '#639d86'
  ctx.beginPath()
  ctx.moveTo(16, floor + 15)
  ctx.lineTo(304, floor + 15)
  ctx.stroke()

  ctx.fillStyle = '#81d9b5'
  ctx.beginPath()
  ctx.ellipse(x, floor + 12, 11, 2, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#bdf5df'
  ctx.beginPath()
  ctx.arc(x, y, 15, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#effcf7'
  ctx.beginPath()
  ctx.arc(x - 4, y - 5, 4, 0, Math.PI * 2)
  ctx.fill()
}

reset()
if (debug) {
  playHint.textContent = t('再生中はタップか Space、停止中は「手動操作」で跳ね上げます。', 'While playing, tap or press Space to boost. While paused, use Manual actions.')
  workbench = mountWorkbench({
    preview, clock, update,
    layout: { storageKey: 'game-debug-workbench.demo.layout.v1', header: document.querySelector('[data-gdw-page-header]') },
    workPresets: { storageKey: 'game-debug-workbench.demo.work.v1' },
    events: [
      { id: 'floor', label: t('床に当たる', 'Hit the floor') },
      { id: 'wall', label: t('壁に当たる', 'Hit a wall') },
      { id: 'boost', label: t('跳ね上げる', 'Boost the ball') },
    ],
    replay: { deterministic: true, applyInput },
    initialScene: 'start',
    scenes: [
      { id: 'start', label: t('初期位置', 'Starting position'), load: reset },
      { id: 'landing', label: t('着地の直前', 'Before landing'), load: () => {
        restoreBall({ x: 160, y: floor - 4, vx: 95, vy: 240, bounces: 0, seed: 271828 })
      } },
      { id: 'resting', label: t('床で静止', 'Resting on the floor'), load: () => {
        restoreBall({ x: 160, y: floor, vx: 0, vy: 0, bounces: 0, seed: 271828 })
      } },
    ],
    sceneSaves: {
      gameId: 'workbench-ball', stateVersion: 1,
      storageKey: 'game-debug-workbench.demo.scenes.v1',
      validateState: validBall,
      capture: ballState,
      restore(state) {
        const restored = state && typeof state === 'object' && !Object.hasOwn(state, 'seed') ?
          { ...state, seed: 271828 } : state
        if (!validBall(restored)) {
          throw new TypeError(t('保存したボールの状態が無効です', 'Invalid saved ball state'))
        }
        restoreBall(restored)
      },
    },
    tuningPresets: { storageKey: 'game-debug-workbench.demo.tuning.v1' },
    viewports: [
      { id: 'compact', label: t('小さめのスマホ · 320×480', 'Small phone · 320×480'), width: 320, height: 480 },
      { id: 'phone', label: t('スマホ · 390×600', 'Phone · 390×600'), width: 390, height: 600 },
      { id: 'wide', label: t('横長 · 560×440', 'Landscape · 560×440'), width: 560, height: 440 },
    ],
    reproduction: { read: ballState },
    tuning: [
      { id: 'gravity', label: t('重力', 'Gravity'), min: 120, max: 800, step: 1, read: () => gravity,
        write: value => { gravity = value }, format: value => value + ' px/s²' },
      { id: 'elasticity', label: t('反発係数', 'Restitution'), min: 0.2, max: 1, step: 0.01, read: () => elasticity,
        write: value => { elasticity = value } },
    ],
    actionsWhilePaused: true,
    actionsHint: t('停止してボールを跳ね上げ、「1コマ進む」で高さの変化を確かめます。', 'Pause, boost the ball, then use Next frame to inspect its height.'),
    actions: [
      { label: t('ボールを跳ね上げる', 'Boost the ball'), run: () => boost() && t('上向きに ', 'Upward at ') + Math.abs(vy) + ' px/s' },
    ],
    readState: () => ({
      [t('高さ', 'Height')]: (floor - y).toFixed(1) + ' px',
      [t('上下速度', 'Vertical speed')]: vy.toFixed(1) + ' px/s',
      [t('反発回数', 'Bounces')]: bounces,
    }),
  })
}

function playBoost() {
  if (clock.state().paused) return
  boost()
  workbench?.record(t('プレビューから跳ね上げる', 'Boosted from the preview'))
}
canvas.addEventListener('pointerdown', playBoost)
canvas.addEventListener('keydown', event => {
  if (event.code !== 'Space') return
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) playBoost()
})

let previous = null
let refreshed = 0
document.addEventListener('visibilitychange', () => { previous = null })
function frame(now) {
  if (previous !== null && !document.hidden) clock.advance((now - previous) / 1000, update)
  previous = now
  render()
  if (now - refreshed >= 100) {
    workbench?.refresh()
    refreshed = now
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
