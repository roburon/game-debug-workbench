;(function () {
  'use strict'
  const { createPreviewClock, mountWorkbench } = GameDebugWorkbench
  const locale = GameDebugWorkbench.resolveLocale()
  const t = (ja, en) => locale === 'ja' ? ja : en
  document.documentElement.lang = locale
  document.title = t('3レーンの配達 · デバッグ見本', 'Three-lane delivery · Debug demo')
  document.querySelector('h1').textContent = t('ゲームの調整とデバッグ', 'Game tuning and debugging')
  document.querySelector('nav').setAttribute('aria-label', t('見本の切り替え', 'Choose a demo'))
  document.querySelector('nav a').textContent = t('ボールの反発', 'Bouncing ball')
  document.querySelector('nav [aria-current]').textContent = t('3レーンの配達', 'Three-lane delivery')
  const preview = document.querySelector('.preview')
  const canvas = preview.querySelector('canvas')
  const playHint = preview.querySelector('[data-play-hint]')
  canvas.setAttribute('aria-label', t('3レーンの配達。左右キーで荷物を受け取る', 'Three-lane delivery. Use the left and right arrow keys to catch parcels.'))
  preview.querySelector('.lane-controls').setAttribute('aria-label', t('配達の操作', 'Delivery controls'))
  preview.querySelector('[data-move="-1"]').textContent = t('左へ', 'Left')
  preview.querySelector('[data-move="1"]').textContent = t('右へ', 'Right')
  playHint.textContent = t('左右キーかボタンで荷物の下へ移動', 'Use the arrow keys or buttons to move under the parcels')
  const ctx = canvas.getContext('2d')
  const debug = new URLSearchParams(location.search).get('debug') !== '0'
  let fallSpeed = 125
  let spawnInterval = 1.2
  let state
  let workbench

  function captureState() {
    return { ...state, parcels: state.parcels.map(parcel => ({ ...parcel })) }
  }

  function validState(value) {
    return value && Number.isInteger(value.lane) && value.lane >= 0 && value.lane <= 2 &&
      ['delivered', 'missed', 'nextId'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
      Number.isInteger(value.seed) && value.seed >= 0 && value.seed <= 0xffffffff &&
      Number.isFinite(value.spawnRemaining) && value.spawnRemaining >= 0 && value.spawnRemaining <= 2 &&
      Array.isArray(value.parcels) && value.parcels.length <= 100 &&
      new Set(value.parcels.map(parcel => parcel?.id)).size === value.parcels.length &&
      value.parcels.every(parcel => parcel && Number.isSafeInteger(parcel.id) && parcel.id >= 0 && parcel.id < value.nextId &&
        Number.isInteger(parcel.lane) && parcel.lane >= 0 && parcel.lane <= 2 &&
        Number.isFinite(parcel.y) && parcel.y >= 40 && parcel.y <= 356)
  }

  function restoreState(value) {
    if (!validState(value)) throw new TypeError(t('保存した配達の状態が無効です', 'Invalid saved delivery state'))
    state = { ...value, parcels: value.parcels.map(parcel => ({ ...parcel })) }
  }

  function reset() {
    restoreState({ lane: 1, delivered: 0, missed: 0, nextId: 0, spawnRemaining: 0.6, seed: 314159, parcels: [] })
  }

  function random() {
    state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0
    return state.seed / 0x100000000
  }

  function applyInput(input) {
    if (input?.type !== 'move' || ![-1, 1].includes(input.direction)) throw new TypeError(t('未対応の配達操作です', 'Unsupported delivery input'))
    const next = Math.max(0, Math.min(2, state.lane + input.direction))
    if (next === state.lane) return
    state.lane = next
    workbench?.notifyEvent('move')
  }

  function move(direction) {
    const input = { type: 'move', direction }
    if (workbench) return workbench.input(input)
    applyInput(input)
  }

  function update(dt) {
    const events = []
    state.spawnRemaining -= dt
    if (state.spawnRemaining <= 0) {
      state.parcels.push({ id: state.nextId++, lane: Math.floor(random() * 3), y: 40 })
      state.spawnRemaining += spawnInterval
      events.push('spawn')
    }
    for (const parcel of state.parcels) {
      parcel.y += fallSpeed * dt
      if (parcel.y < 356) continue
      if (parcel.lane === state.lane) {
        state.delivered += 1
        events.push('delivery')
      } else {
        state.missed += 1
        events.push('miss')
      }
    }
    state.parcels = state.parcels.filter(parcel => parcel.y < 356)
    for (const event of events) workbench?.notifyEvent(event)
  }

  function render() {
    ctx.fillStyle = '#112820'
    ctx.fillRect(0, 0, 320, 440)
    ctx.font = '16px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillStyle = '#edfbf7'
    ctx.fillText(t('配達 ', 'Delivered ') + state.delivered, 20, 28)
    ctx.textAlign = 'right'
    ctx.fillStyle = '#efbc8f'
    ctx.fillText(t('取り逃し ', 'Missed ') + state.missed, 300, 28)
    for (let lane = 0; lane < 3; lane += 1) {
      const x = 16 + lane * 100
      ctx.fillStyle = lane === state.lane ? '#244e3e' : '#18372c'
      ctx.fillRect(x, 42, 88, 360)
      ctx.fillStyle = '#81d9b5'
      ctx.font = '13px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(String(lane + 1), x + 44, 425)
    }
    for (const parcel of state.parcels) {
      const x = 60 + parcel.lane * 100
      ctx.fillStyle = '#efbc8f'
      ctx.fillRect(x - 15, parcel.y - 13, 30, 26)
      ctx.strokeStyle = '#765134'
      ctx.strokeRect(x - 15, parcel.y - 13, 30, 26)
      ctx.beginPath()
      ctx.moveTo(x, parcel.y - 13)
      ctx.lineTo(x, parcel.y + 13)
      ctx.stroke()
    }
    const playerX = 60 + state.lane * 100
    ctx.fillStyle = '#bdf5df'
    ctx.fillRect(playerX - 28, 365, 56, 22)
    ctx.strokeStyle = '#effcf7'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(playerX - 28, 355)
    ctx.lineTo(playerX - 28, 386)
    ctx.lineTo(playerX + 28, 386)
    ctx.lineTo(playerX + 28, 355)
    ctx.stroke()
    ctx.lineWidth = 1
  }

  reset()
  const clock = createPreviewClock(debug ? { history: { capture: captureState, restore: restoreState } } : undefined)
  if (debug) {
    playHint.textContent = t('再生中は左右キーかボタン、停止中は「手動操作」でレーンを移ります。', 'While playing, use the arrow keys or buttons to change lanes. While paused, use Manual actions.')
    workbench = mountWorkbench({
      preview, clock, update,
      layout: { storageKey: 'game-debug-workbench.lanes.layout.v1', header: document.querySelector('[data-gdw-page-header]') },
      workPresets: { storageKey: 'game-debug-workbench.lanes.work.v1' },
      initialScene: 'start',
      scenes: [
        { id: 'start', label: t('配達の開始', 'Start delivery'), load: reset },
        { id: 'delivery', label: t('受け取りの直前', 'Before a catch'), load() {
          reset()
          state.nextId = 1
          state.parcels = [{ id: 0, lane: 1, y: 350 }]
        } },
        { id: 'miss', label: t('取り逃しの直前', 'Before a miss'), load() {
          reset()
          state.nextId = 1
          state.parcels = [{ id: 0, lane: 0, y: 350 }]
        } },
      ],
      sceneSaves: {
        gameId: 'workbench-lanes', stateVersion: 1,
        storageKey: 'game-debug-workbench.lanes.scenes.v1',
        capture: captureState, validateState: validState, restore: restoreState,
      },
      tuningPresets: { storageKey: 'game-debug-workbench.lanes.tuning.v1' },
      events: [
        { id: 'spawn', label: t('荷物が出る', 'Parcel appears') },
        { id: 'delivery', label: t('荷物を受け取る', 'Catch a parcel') },
        { id: 'miss', label: t('荷物を取り逃す', 'Miss a parcel') },
        { id: 'move', label: t('レーンを移る', 'Change lanes') },
      ],
      replay: { deterministic: true, applyInput },
      reproduction: { read: captureState },
      tuning: [
        { id: 'fallSpeed', label: t('荷物の速さ', 'Parcel speed'), min: 60, max: 300, step: 1,
          read: () => fallSpeed, write: value => { fallSpeed = value }, format: value => value + ' px/s' },
        { id: 'spawnInterval', label: t('荷物の間隔', 'Spawn interval'), min: 0.4, max: 2, step: 0.01,
          read: () => spawnInterval, write: value => { spawnInterval = value }, format: value => value + t(' 秒', ' s') },
      ],
      actionsWhilePaused: true,
      actionsHint: t('停止して左右のボタンを押すと、配達員だけが隣のレーンに移ります。', 'While paused, use these buttons to move the courier to the adjacent lane.'),
      actions: [
        { label: t('左レーンへ移る', 'Move one lane left'), run: () => move(-1) && t('現在地：レーン', 'Current lane: ') + (state.lane + 1), enabled: () => state.lane > 0 },
        { label: t('右レーンへ移る', 'Move one lane right'), run: () => move(1) && t('現在地：レーン', 'Current lane: ') + (state.lane + 1), enabled: () => state.lane < 2 },
      ],
      viewports: [
        { id: 'phone', label: t('スマホ · 320×540', 'Phone · 320×540'), width: 320, height: 540 },
        { id: 'wide', label: t('横長 · 560×440', 'Landscape · 560×440'), width: 560, height: 440 },
      ],
      readState: () => ({
        [t('レーン', 'Lane')]: state.lane + 1, [t('配達数', 'Delivered')]: state.delivered, [t('取り逃し', 'Missed')]: state.missed,
        [t('荷物の数', 'Parcels')]: state.parcels.length, [t('次の荷物まで', 'Next parcel in')]: state.spawnRemaining.toFixed(2) + t(' 秒', ' s'), [t('乱数状態', 'Random seed')]: state.seed,
      }),
    })
  }

  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.code)) return
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat && !clock.state().paused) move(event.code === 'ArrowLeft' ? -1 : 1)
  })
  for (const button of preview.querySelectorAll('[data-move]')) {
    button.addEventListener('click', () => {
      if (!clock.state().paused) move(Number(button.dataset.move))
    })
  }

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
})()
