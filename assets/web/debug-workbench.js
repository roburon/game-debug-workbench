;(function (scope) {
  'use strict'

  const defaultRates = [0.25, 0.5, 1, 1.5, 2]
  const defaultRateRange = { min: 0.25, max: 2, step: 0.01 }

  function resolveLocale(preferences) {
    if (preferences == null || preferences === 'auto') {
      preferences = [...(scope.navigator?.languages ?? []), scope.navigator?.language]
    }
    for (const preference of Array.isArray(preferences) ? preferences : [preferences]) {
      if (typeof preference !== 'string') continue
      const language = preference.trim().split('-')[0].toLowerCase()
      if (language === 'ja' || language === 'en') return language
    }
    return 'en'
  }

  function browserText(ja, en) { return resolveLocale() === 'ja' ? ja : en }

  function supportsRate(value, rates, range) {
    if (!range) return Array.isArray(rates) && rates.includes(value)
    if (!Number.isFinite(value) || value < range.min || value > range.max) return false
    const steps = (value - range.min) / range.step
    return Math.abs(steps - Math.round(steps)) < 1e-7
  }

  function validClockState(state, clock) {
    return Number.isSafeInteger(state?.ticks) && state.ticks >= 0 && supportsRate(state.rate, clock.rates, clock.rateRange)
  }

  class TuningRollbackError extends Error {}

  function createPreviewClock({ stepSeconds = 1 / 60, maxDeltaSeconds = 0.1, rates = defaultRates,
    rateRange = rates === defaultRates ? defaultRateRange : null, history } = {}) {
    rates = [...rates]
    if (rateRange != null) {
      const { min, max, step } = rateRange
      if (![min, max, step].every(Number.isFinite) || min <= 0 || max <= min || step <= 0 ||
          ![max, ...rates].every(value => supportsRate(value, rates, rateRange))) {
        throw new RangeError(browserText('再生速度の範囲・刻みと倍率ボタンの値を確認してください', 'Check the playback speed range, step, and speed button values'))
      }
      rateRange = Object.freeze({ min, max, step })
    }
    if (!Number.isFinite(stepSeconds) || stepSeconds <= 0 ||
        !Number.isFinite(maxDeltaSeconds) || maxDeltaSeconds < stepSeconds ||
        !rates.includes(1) || rates.some(rate => !Number.isFinite(rate) || rate <= 0)) {
      throw new RangeError(browserText('時間操作の設定が無効です', 'Invalid playback controls configuration'))
    }
    let paused = false
    let rate = 1
    let remaining = 0
    let ticks = 0

    const historySeconds = history?.seconds ?? 5
    if (history && (!Number.isFinite(historySeconds) || historySeconds <= 0 ||
        typeof history.capture !== 'function' || typeof history.restore !== 'function')) {
      throw new TypeError(browserText('巻き戻し履歴の設定が無効です', 'Invalid rewind history configuration'))
    }
    const capacity = history ? Math.min(3600, Math.max(1, Math.ceil(historySeconds / stepSeconds))) : 0
    const snapshots = new Array(capacity)
    let next = 0
    let available = 0

    const listeners = new Set()
    let searchBudget = 0
    let onSearchLimit
    function tick(update) {
      const snapshot = history?.capture()
      for (const hook of listeners) if (hook.before?.() === false) return false
      update(stepSeconds)
      if (history) {
        snapshots[next] = snapshot
        next = (next + 1) % capacity
        available = Math.min(available + 1, capacity)
      }
      ticks += 1
      for (const hook of listeners) hook.after?.()
      return true
    }

    function canRewind() { return paused && available > 0 }

    function rewind() {
      if (!canRewind()) return false
      const position = (next + capacity - 1) % capacity
      history.restore(snapshots[position])
      snapshots[position] = undefined
      next = position
      available -= 1
      ticks -= 1
      remaining = 0
      return true
    }

    function reset() {
      remaining = 0
      ticks = 0
      next = 0
      available = 0
      snapshots.fill(undefined)
      searchBudget = 0
    }

    return {
      rates: Object.freeze(rates),
      rateRange,
      state: () => ({ paused, rate, time: ticks * stepSeconds, ticks }),
      setPaused(value) {
        paused = Boolean(value)
        if (paused) {
          remaining = 0
          searchBudget = 0
        }
      },
      onTick(before, after) {
        const hook = { before, after }
        listeners.add(hook)
        return () => listeners.delete(hook)
      },
      seekEvent(onLimit) {
        searchBudget = Math.ceil(60 / stepSeconds)
        onSearchLimit = onLimit
        remaining = 0
        paused = false
      },
      setRate(value) {
        if (!supportsRate(value, rates, rateRange)) throw new RangeError(browserText('未対応の再生速度です', 'Unsupported playback speed'))
        rate = value
      },
      advance(deltaSeconds, update) {
        if (paused || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return
        if (searchBudget > 0) {
          // 既存の描画ループに戻りながら、最長でゲーム内の60秒先まで探す。
          for (let i = 0; i < 60 && searchBudget > 0 && !paused; i++) {
            searchBudget--
            if (!tick(update)) break
            if (searchBudget === 0 && !paused) {
              paused = true
              onSearchLimit?.()
            }
          }
          return
        }
        remaining += Math.min(deltaSeconds, maxDeltaSeconds) * rate
        while (!paused && remaining + stepSeconds * 1e-9 >= stepSeconds) {
          remaining -= stepSeconds
          if (!tick(update)) break
        }
      },
      step(update) {
        if (!paused) return false
        return tick(update)
      },
      ...(history ? { canRewind, rewind } : {}),
      reset,
      restoreState(state) {
        if (!validClockState(state, { rates, rateRange })) throw new RangeError(browserText('保存した時計の状態が無効です', 'Invalid saved clock state'))
        reset()
        ticks = state.ticks
        rate = state.rate
      },
    }
  }

  const cardGenres = {
    preview: 'view',
    scenes: 'play', time: 'play', actions: 'play', breakpoints: 'play',
    tuning: 'tune', 'tuning-presets': 'tune',
    state: 'inspect', events: 'inspect',
    reproduction: 'save', replay: 'save', 'work-presets': 'save',
  }

  function mountWorkbench({
    preview, clock, update, tuning = [], actions = [], actionsHint, actionsWhilePaused = false, readState,
    scenes = [], initialScene, sceneSaves, tuningPresets, viewports = [], reproduction, layout,
    events = [], workPresets, replay, locale,
  }) {
    const resolvedLocale = resolveLocale(locale)
    const t = (ja, en) => resolvedLocale === 'ja' ? ja : en
    const genreNames = { view: t('表示', 'View'), play: t('操作', 'Play'), tune: t('調整', 'Tune'),
      inspect: t('状態・ログ', 'State & logs'), save: t('保存・再現', 'Save & reproduce') }
    if (!preview?.parentNode) throw new TypeError(t('プレビューを先に配置してください', 'Place the preview in the document first'))
    if (typeof clock?.step === 'function' && typeof update !== 'function') throw new TypeError(t('ゲームの更新関数が必要です', 'A game update function is required'))

    if (sceneSaves && (typeof sceneSaves.capture !== 'function' || typeof sceneSaves.restore !== 'function')) {
      throw new TypeError(t('場面の保存・復元関数が必要です', 'Scene capture and restore functions are required'))
    }

    if (layout && (typeof layout.storageKey !== 'string' || !layout.storageKey.trim())) {
      throw new TypeError(t('カード配置に作品固有の保存キーが必要です', 'Card layout requires a storage key unique to this game'))
    }
    if (layout && !scope.GameDebugBoard) {
      throw new Error(t('カード配置を使うには workbench-board.js を読み込んでください', 'Load workbench-board.js to use card layouts'))
    }

    const doc = preview.ownerDocument
    function element(tag, content) {
      const item = doc.createElement(tag)
      if (content !== undefined) item.textContent = content
      return item
    }
    function button(text, onClick) {
      const item = element('button', text)
      item.type = 'button'
      item.addEventListener('click', onClick)
      return item
    }
    function cardHeading(card, title, cardId) {
      const heading = element('h2')
      heading.className = 'gdw-card-heading'
      heading.append(element('span', title))
      const genre = cardGenres[cardId]
      if (genre) {
        card.dataset.gdwGenre = genre
        card.setAttribute('aria-description', t('ジャンル：', 'Category: ') + genreNames[genre])
        const tag = element('span', genreNames[genre])
        tag.className = 'gdw-genre-name'
        tag.setAttribute('aria-hidden', 'true')
        heading.append(tag)
      }
      return heading
    }

    // 入力途中の「0.」や空欄は、ゲームの定期更新で書き戻さない。
    function numberEditor(label, min, max, step, apply, check) {
      const input = element('input')
      input.className = 'gdw-number-input'
      input.type = 'number'
      input.min = min
      input.max = max
      input.step = step
      input.required = true
      input.setAttribute('aria-label', label)
      let editing = false
      let current
      function reset() {
        editing = false
        input.setCustomValidity('')
        input.removeAttribute('aria-invalid')
        input.value = String(current)
      }
      function commit() {
        if (!editing || input.disabled || !input.validity.valid) return
        editing = false
        if (input.valueAsNumber !== current) apply(input.valueAsNumber)
        reset()
      }
      input.addEventListener('input', () => {
        editing = true
        input.setCustomValidity(check?.(input.valueAsNumber) ?? '')
        input.setAttribute('aria-invalid', String(!input.validity.valid))
      })
      input.addEventListener('change', commit)
      input.addEventListener('blur', () => { commit(); reset() })
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          if (input.reportValidity()) commit()
        } else if (event.key === 'Escape' && editing) {
          event.preventDefault()
          event.stopPropagation()
          reset()
        }
      })
      function sync(value, disabled) {
        input.disabled = disabled
        if (current !== value || (disabled && editing)) {
          current = value
          reset()
        }
      }
      return { input, sync }
    }

    function section(title, cardId) {
      const item = element('section')
      item.setAttribute('aria-label', title)
      if (layout) item.dataset.gdwCard = cardId
      item.append(cardHeading(item, title, cardId))
      return item
    }

    function cardHeader(panel, ...controls) {
      const header = element('div')
      header.className = 'gdw-card-header'
      header.append(panel.firstElementChild, ...controls)
      panel.prepend(header)
      return header
    }

    function foldPanel(panel, open = false) {
      const summary = element('summary')
      summary.append(panel.firstElementChild)
      const body = element('div')
      body.className = 'gdw-fold-body'
      body.append(...panel.childNodes)
      const disclosure = element('details')
      disclosure.className = 'gdw-panel-disclosure'
      disclosure.open = open
      disclosure.append(summary, body)
      panel.classList.add('gdw-foldable')
      panel.append(disclosure)
      return panel
    }

    function labeledSelect(panel, title, options) {
      const label = element('label')
      label.className = 'gdw-select'
      label.append(element('span', title))
      const select = element('select')
      select.setAttribute('aria-label', title)
      for (const { id, label: text } of options) {
        const option = element('option', text)
        option.value = id
        select.append(option)
      }
      label.append(select)
      panel.append(label)
      return select
    }
    function notice(panel) {
      const item = element('p')
      item.className = 'gdw-status'
      item.setAttribute('role', 'status')
      panel.append(item)
      return item
    }
    const root = element('div')
    root.className = 'game-debug-workbench'
    root.lang = resolvedLocale
    const controls = element('aside')
    controls.className = 'gdw-controls'
    controls.setAttribute('aria-label', t('調整', 'Tune'))
    const stage = element('div')
    stage.className = 'gdw-stage'
    const previewBody = element('div')
    previewBody.className = 'gdw-preview-body'
    const observer = element('aside')
    observer.className = 'gdw-observer'
    observer.setAttribute('aria-label', t('デバッグ', 'Debug'))
    root.append(stage, controls, observer)

    const controlsRefresh = []
    const entries = []
    let currentScene = scenes.find(item => item.id === initialScene) ?? null
    let registerRestoredScene = point => scenes.find(scene => scene.id === point.scene?.id) ?? null
    let currentViewport = null
    let loadingScene = false
    let applyingWork = false
    let cancelFrameHold
    let replayPanel
    const profiles = {}
    const isLocked = () => loadingScene || applyingWork || Boolean(replayPanel?.isBusy())
    const available = new Map(scenes.map(scene => [scene.id, scene]))
    let selectScene
    let setViewport
    let board
    const metrics = element('dl')
    const values = new Map()
    const statePanel = section(t('実行状態', 'Runtime state'), 'state')
    const history = element('ol')
    const historyPanel = section(t('イベント履歴', 'Event history'), 'events')
    const historyCount = element('span', t('0件', '0 events'))
    historyCount.className = 'gdw-history-count'
    historyPanel.querySelector('h2').append(historyCount)
    statePanel.append(metrics)
    historyPanel.append(history)
    observer.append(statePanel, foldPanel(historyPanel))

    let lastFrameAction = ''
    let repeatCount = 0
    function record(message, frameAction = '') {
      const time = clock?.state().time ?? null
      const repeat = frameAction && frameAction === lastFrameAction
      lastFrameAction = frameAction
      repeatCount = repeat ? repeatCount + 1 : 1
      if (repeat) {
        entries.shift()
        history.firstElementChild.remove()
        message += t('（' + repeatCount + '回）', ' (' + repeatCount + ' times)')
      }
      entries.unshift({ time, message: String(message) })
      if (entries.length > 20) entries.pop()
      const item = element('li')
      if (time !== null) {
        const stamp = element('span', time.toFixed(2) + t('秒', 's'))
        stamp.className = 'gdw-log-time'
        item.append(stamp, ' ')
      }
      item.append(element('span', message))
      history.prepend(item)
      if (history.childElementCount > 20) history.lastElementChild.remove()
      historyCount.textContent = t(entries.length + '件', entries.length + ' events')
    }

    function refresh() {
      for (const updateControl of controlsRefresh) updateControl()
      const timing = clock?.state()
      if (cancelFrameHold && (loadingScene || applyingWork || !timing?.paused)) cancelFrameHold()
      const status = timing ? {
        [t('状態', 'Status')]: timing.paused ? t('停止中', 'Paused') : t('再生中', 'Playing'),
        [t('ゲーム内時刻', 'Game time')]: timing.time.toFixed(3) + t('秒', 's'),
        [t('更新回数', 'Updates')]: timing.ticks,
      } : {}
      if (currentScene) status[t('場面', 'Scene')] = currentScene.label
      const rows = Object.entries({ ...status, ...readState?.() })
      statePanel.hidden = rows.length === 0
      const active = new Set(rows.map(([label]) => label))
      for (const [label, group] of values) {
        if (!active.has(label)) {
          group.remove()
          values.delete(label)
        }
      }
      for (const [label, value] of rows) {
        if (!values.has(label)) {
          const group = element('div')
          group.append(element('dt', label), element('dd'))
          metrics.append(group)
          values.set(label, group)
        }
        const field = values.get(label).lastElementChild
        const display = value == null ? '—' : String(value)
        if (field.textContent !== display) field.textContent = display
      }
    }

    function setPaused(hold) {
      if (loadingScene || typeof clock?.setPaused !== 'function' || clock.state().paused === hold) return
      clock.setPaused(hold)
      record(hold ? t('停止', 'Pause') : t('再開', 'Resume'))
      refresh()
    }
    function advanceFrame() {
      if (loadingScene || !clock.state().paused) return
      if (clock.step(update)) record(t('1コマ進む', 'Next frame'), 'step')
      refresh()
    }
    function frameButton(label, move) {
      const win = doc.defaultView
      let pointerHandled = false
      const item = button(label, event => {
        // ポインターの離し際は下で処理する。支援技術からの click は1回分として扱う。
        if (!pointerHandled || !(event.detail || event.pointerType)) move()
        pointerHandled = false
      })
      item.className = 'gdw-frame-button'
      item.title = label + t('（長押しで連続）', ' (hold to repeat)')

      function begin(event) {
        const pointer = event.type === 'pointerdown'
        if (pointer) {
          if (!event.isPrimary || event.button !== 0) return
          pointerHandled = true
        } else {
          if (event.key !== ' ' && event.key !== 'Enter') return
          event.preventDefault()
          if (event.repeat) return
        }
        cancelFrameHold?.()
        const listeners = new win.AbortController()
        const options = { signal: listeners.signal }
        let repeated = false
        let timer = win.setTimeout(repeat, 350)
        cancelFrameHold = stop
        function stop() {
          win.clearTimeout(timer)
          listeners.abort()
          cancelFrameHold = null
          if (pointer && item.hasPointerCapture(event.pointerId)) item.releasePointerCapture(event.pointerId)
        }
        function release() {
          stop()
          if (!repeated && !item.disabled) move()
        }
        function repeat() {
          if (item.disabled || !item.getClientRects().length || !clock.state().paused) { stop(); return }
          repeated = true
          move()
          if (cancelFrameHold === stop) timer = win.setTimeout(repeat, 80)
        }
        if (pointer) {
          item.setPointerCapture(event.pointerId)
          const inside = e => {
            const r = item.getBoundingClientRect()
            return e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom
          }
          item.addEventListener('pointermove', e => { if (e.pointerId === event.pointerId && !inside(e)) stop() }, options)
          item.addEventListener('pointerup', e => {
            if (e.pointerId !== event.pointerId) return
            if (inside(e)) release()
            else stop()
          }, options)
          item.addEventListener('contextmenu', e => e.preventDefault(), options)
          for (const type of ['pointercancel', 'lostpointercapture']) {
            item.addEventListener(type, e => { if (e.pointerId === event.pointerId) stop() }, options)
          }
        } else {
          item.addEventListener('keyup', e => {
            if (e.key === event.key) { e.preventDefault(); release() }
          }, options)
        }
        item.addEventListener('blur', stop, options)
        win.addEventListener('blur', stop, options)
        win.addEventListener('pagehide', stop, options)
        doc.addEventListener('visibilitychange', () => { if (doc.hidden) stop() }, options)
      }
      item.addEventListener('pointerdown', begin)
      item.addEventListener('keydown', begin)
      return item
    }
    if (clock) {
      const panel = section(t('時間操作', 'Playback controls'), 'time')
      const togglePause = () => setPaused(!clock.state().paused)
      const rewindFrame = () => {
        if (isLocked() || !clock.canRewind()) return
        replayPanel?.clearPending()
        if (clock.rewind()) record(t('1コマ戻る', 'Previous frame'), 'rewind')
        refresh()
      }
      const timeViews = []
      function timeButtons() {
        const buttons = element('div')
        buttons.className = 'gdw-buttons'
        const pause = typeof clock.setPaused === 'function' ? button(t('停止', 'Pause'), togglePause) : null
        const step = typeof clock.step === 'function' ? frameButton(t('1コマ進む', 'Next frame'), advanceFrame) : null
        const rewind = typeof clock.rewind === 'function' && typeof clock.canRewind === 'function'
          ? frameButton(t('1コマ戻る', 'Previous frame'), rewindFrame) : null
        if (pause) { pause.dataset.gdwTime = 'pause'; buttons.append(pause) }
        if (rewind) { rewind.dataset.gdwTime = 'rewind'; buttons.append(rewind) }
        if (step) { step.dataset.gdwTime = 'step'; buttons.append(step) }
        timeViews.push({ pause, step, rewind })
        return buttons
      }
      const buttons = timeButtons()
      const previewTime = element('div')
      previewTime.className = 'gdw-preview-time'
      previewTime.setAttribute('role', 'group')
      previewTime.setAttribute('aria-label', t('プレビューの時間操作', 'Preview playback controls'))
      const previewTiming = element('p')
      previewTiming.className = 'gdw-preview-timing'
      previewTiming.dataset.gdwPreviewStatus = ''
      previewTime.append(previewTiming, timeButtons())
      stage.append(previewTime)
      const rates = element('div')
      rates.className = 'gdw-rates'
      rates.setAttribute('role', 'group')
      rates.setAttribute('aria-label', t('再生速度', 'Playback speed'))
      const speedCaption = element('span', t('再生速度', 'Playback speed'))
      speedCaption.setAttribute('aria-hidden', 'true')
      const scale = element('div')
      scale.className = 'gdw-rate-scale'
      rates.append(speedCaption, scale)
      const rateOptions = Array.isArray(clock.rates) && typeof clock.setRate === 'function' ? clock.rates : []
      const range = typeof clock.setRate === 'function' ? clock.rateRange : null
      rates.style.setProperty('--gdw-rate-count', rateOptions.length)
      const slider = element('input')
      slider.className = 'gdw-rate-slider'
      slider.type = 'range'
      slider.min = range?.min ?? 0
      slider.max = range?.max ?? rateOptions.length - 1
      slider.step = range?.step ?? 1
      slider.setAttribute('aria-label', t('再生速度', 'Playback speed'))

      function selectRate(value) {
        if (loadingScene) return false
        if (clock.state().rate === value) return false
        clock.setRate(value)
        refresh()
        return true
      }

      function setAndLogRate(value) {
        if (selectRate(value)) record(value + t('倍速', '× speed'))
      }
      const number = numberEditor(t('再生速度（倍）', 'Playback speed (×)'), range?.min ?? (rateOptions.length ? Math.min(...rateOptions) : 1),
        range?.max ?? (rateOptions.length ? Math.max(...rateOptions) : 1), range?.step ?? 'any', setAndLogRate,
        value => (range || rateOptions.includes(value)) ? '' : t(rateOptions.join('、') + ' 倍から選んでください', 'Choose a speed from ' + rateOptions.join(', ') + '×'))
      const line = element('div')
      line.className = 'gdw-slider-line'
      const entry = element('span')
      entry.className = 'gdw-rate-entry'
      entry.append(number.input, '×')
      slider.addEventListener('input', () => selectRate(range ? slider.valueAsNumber : rateOptions[slider.valueAsNumber]))
      slider.addEventListener('change', () => record(clock.state().rate + t('倍速', '× speed')))
      if (range || rateOptions.length > 1) {
        line.append(slider, entry)
        scale.append(line)
      }

      const choices = element('div')
      choices.className = 'gdw-rate-choices'
      choices.setAttribute('role', 'group')
      choices.setAttribute('aria-label', t('よく使う倍率', 'Common speeds'))
      const rateButtons = rateOptions.map(value => {
        const choice = button(value + '×', () => setAndLogRate(value))
        choice.setAttribute('aria-label', value + t('倍', '×'))
        choices.append(choice)
        return choice
      })
      if (rateButtons.length) scale.append(choices)
      const timeControls = element('div')
      timeControls.className = 'gdw-time-controls'
      if (range || rateOptions.length) timeControls.append(rates)
      const timeState = element('span')
      timeState.className = 'gdw-clock-state'
      const transportGroup = element('div')
      transportGroup.className = 'gdw-playback-group'
      const titleLine = element('div')
      titleLine.className = 'gdw-playback-title'
      titleLine.append(panel.firstElementChild, timeState)
      transportGroup.append(titleLine)
      if (buttons.childElementCount) transportGroup.append(buttons)
      const playback = element('div')
      playback.className = 'gdw-card-header gdw-transport'
      playback.append(transportGroup)
      if (timeControls.childElementCount) playback.append(timeControls)
      panel.append(playback)
      controls.append(panel)
      controlsRefresh.push(() => {
        const state = clock.state()
        const stateName = state.paused ? t('停止中', 'Paused') : t('再生中', 'Playing')
        if (timeState.textContent !== stateName) {
          timeState.textContent = stateName
          timeState.dataset.paused = String(state.paused)
        }
        for (const { pause, step, rewind } of timeViews) {
          if (pause) {
            if (pause.dataset.paused !== String(state.paused)) {
              pause.textContent = state.paused ? t('再開', 'Resume') : t('停止', 'Pause')
              pause.dataset.paused = String(state.paused)
            }
            pause.disabled = loadingScene
          }
          if (step) step.disabled = loadingScene || !state.paused
          if (rewind) rewind.disabled = isLocked() || !clock.canRewind()
        }
        const timingLabel = [state.paused ? t('停止中', 'Paused') : t('再生中', 'Playing'),
          Number.isFinite(state.time) ? state.time.toFixed(3) + t('秒', 's') : '',
          Number.isFinite(state.ticks) ? t(state.ticks + 'コマ', state.ticks + ' frames') : ''].filter(Boolean).join(' · ')
        if (previewTiming.textContent !== timingLabel) previewTiming.textContent = timingLabel
        slider.disabled = loadingScene
        number.sync(state.rate, loadingScene)
        for (const choice of rateButtons) choice.disabled = loadingScene || (!range && rateOptions.length === 1)
        const rateLabel = state.rate + t('倍', '×')
        if (slider.getAttribute('aria-valuetext') === rateLabel) return
        const index = rateOptions.indexOf(state.rate)
        slider.value = String(range ? state.rate : index)
        slider.setAttribute('aria-valuetext', rateLabel)
        rateButtons.forEach((choice, option) => choice.setAttribute('aria-pressed', String(index === option)))
      })
    }

    const tuningKey = control => control.id ?? control.label
    const readTuning = () => Object.fromEntries(tuning.map(control => [tuningKey(control), control.read()]))
    function validTuning(values) {
      return values && tuning.every(control => {
        const value = values[tuningKey(control)]
        return Number.isFinite(value) && value >= Number(control.min) && value <= Number(control.max)
      })
    }

    function writeTuning(values) {
      const previous = readTuning()
      const attempted = []
      function undo() {
        let restored = true
        for (let index = attempted.length - 1; index >= 0; index -= 1) {
          const control = attempted[index]
          try {
            control.write(previous[tuningKey(control)])
          } catch {
            restored = false
          }
        }
        return restored
      }

      try {
        for (const control of tuning) {
          const key = tuningKey(control)
          if (previous[key] === values[key]) continue
          attempted.push(control)
          control.write(values[key])
        }
      } catch {
        if (undo()) throw new Error(t('適用に失敗したため、元の値に戻しました', 'Could not apply the values; the previous values have been restored'))
        throw new TuningRollbackError(t('適用に失敗しました。現在の値を確認してください', 'Could not apply the values. Check the current values'))
      }
      return undo
    }

    const canTransferState = Boolean(sceneSaves && typeof sceneSaves.gameId === 'string' && sceneSaves.gameId.trim() &&
      Number.isSafeInteger(sceneSaves.stateVersion) && sceneSaves.stateVersion >= 1 && typeof sceneSaves.validateState === 'function' &&
      (!clock || typeof clock.restoreState === 'function'))

    function cloneRestoreData(value) {
      const visited = new Set()
      function check(item) {
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return
        if (typeof item === 'number' && Number.isFinite(item)) return
        if (!item || typeof item !== 'object' || visited.has(item) ||
            (!Array.isArray(item) && Object.getPrototypeOf(item) !== null &&
              (Object.prototype.toString.call(item) !== '[object Object]' || Object.getPrototypeOf(item).constructor?.name !== 'Object'))) {
          throw new TypeError(t('復元データは有限の数値を含むJSONにしてください', 'Restore data must be JSON with finite numbers'))
        }
        visited.add(item)
        if (Array.isArray(item)) {
          for (let index = 0; index < item.length; index += 1) check(item[index])
        } else {
          for (const [key, entry] of Object.entries(item)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError(t('復元データに使えない項目があります', 'Restore data contains a prohibited property'))
            check(entry)
          }
        }
        visited.delete(item)
      }
      check(value)
      return JSON.parse(JSON.stringify(value))
    }

    function validateRestorePoint(point) {
      if (!canTransferState) throw new Error(t('この作品は復元データに対応していません', 'This game does not support restore data'))
      const candidate = cloneRestoreData(point)
      if (candidate?.type !== 'game-debug-restore-point' || candidate.version !== 1) {
        throw new Error(t('復元用のJSONを貼り付けてください。診断情報だけでは復元できません', 'Paste restore JSON. Diagnostic information alone cannot restore the state'))
      }
      if (candidate.gameId !== sceneSaves.gameId) throw new Error(t('別の作品の復元データです', 'This restore data belongs to a different game'))
      if (candidate.stateVersion !== sceneSaves.stateVersion) throw new Error(t('作品の保存データの版が一致しません', 'The game save version does not match'))
      if (candidate.scene !== null && (!candidate.scene || typeof candidate.scene.id !== 'string' || !candidate.scene.id ||
          typeof candidate.scene.label !== 'string' || !candidate.scene.label.trim())) throw new Error(t('場面の情報が無効です', 'Invalid scene information'))
      if (!candidate.tuning || Array.isArray(candidate.tuning) || !validTuning(candidate.tuning) ||
          Object.keys(candidate.tuning).length !== tuning.length) throw new Error(t('調整値が現在の設定と一致しません', 'Tuning values do not match the current configuration'))
      if (clock) {
        if (typeof clock.restoreState !== 'function' || !validClockState(candidate.clock, clock) ||
            typeof candidate.clock.paused !== 'boolean' || !Number.isFinite(candidate.clock.time) || candidate.clock.time < 0) {
          throw new Error(t('時計の情報が現在の設定と一致しません', 'Clock data does not match the current configuration'))
        }
      } else if (candidate.clock !== null) throw new Error(t('この作品では時計を復元できません', 'This game cannot restore the clock'))
      if (!Object.hasOwn(candidate, 'state') || sceneSaves.validateState(cloneRestoreData(candidate.state)) !== true) {
        throw new Error(t('作品の状態が無効です', 'Invalid game state'))
      }
      return true
    }

    function captureRestorePoint() {
      if (!canTransferState) throw new Error(t('この作品は復元データに対応していません', 'This game does not support restore data'))
      const timing = clock?.state() ?? null
      const point = cloneRestoreData({
        type: 'game-debug-restore-point', version: 1,
        gameId: sceneSaves?.gameId, stateVersion: sceneSaves?.stateVersion,
        scene: currentScene ? { id: currentScene.id, label: currentScene.label } : null,
        clock: timing ? { paused: timing.paused, rate: timing.rate, time: timing.time, ticks: timing.ticks } : null,
        tuning: readTuning(), state: sceneSaves?.capture(),
      })
      validateRestorePoint(point)
      return point
    }

    async function applyRestorePoint(point) {
      if (loadingScene) throw new Error(t('別の場面を読み込み中です', 'Another scene is loading'))
      validateRestorePoint(point)
      const candidate = cloneRestoreData(point)
      const previous = captureRestorePoint()
      const previousScene = currentScene
      replayPanel?.clearPending()
      loadingScene = true
      clock?.setPaused(true)
      refresh()
      try {
        writeTuning(candidate.tuning)
        await sceneSaves.restore(cloneRestoreData(candidate.state))
        if (clock) {
          clock.restoreState(candidate.clock)
          clock.setPaused(true)
        }
        currentScene = registerRestoredScene(candidate)
        return true
      } catch (error) {
        let restored = true
        try { writeTuning(previous.tuning) } catch { restored = false }
        try { await sceneSaves.restore(cloneRestoreData(previous.state)) } catch { restored = false }
        try {
          if (clock) {
            clock.restoreState(previous.clock)
            clock.setPaused(previous.clock.paused)
          }
        } catch { restored = false }
        currentScene = previousScene
        if (!restored) throw new TuningRollbackError(t('復元に失敗しました。元の状態に戻せなかったため、現在の状態を確認してください', 'Restore failed and the previous state could not be recovered. Check the current state'))
        throw new Error(t('復元に失敗したため、元の状態に戻しました', 'Restore failed; the previous state has been recovered'), { cause: error })
      } finally {
        loadingScene = false
        refresh()
      }
    }

    if (scenes.length || sceneSaves) {
      const panel = section(t('場面の切り替え', 'Scenes'), 'scenes')
      const choices = element('div')
      choices.className = 'gdw-choice-row'
      const select = labeledSelect(choices, t('読み込む場面', 'Scene to load'), [
        { id: '', label: t('場面を選ぶ', 'Choose a scene') },
        ...scenes,
      ])
      selectScene = loadScene
      select.options[0].disabled = true
      select.value = currentScene?.id ?? ''
      select.addEventListener('change', () => loadScene(available.get(select.value)))
      const restart = button(t('読み込み直す', 'Reload'), () => loadScene(currentScene))
      choices.append(restart)
      cardHeader(panel, choices)
      if (sceneSaves) addSceneSaveForm()
      const status = notice(panel)
      controls.append(panel)
      controlsRefresh.push(() => {
        select.value = currentScene?.id ?? ''
        select.disabled = isLocked() || !available.size
        restart.disabled = isLocked() || !currentScene
      })

      async function loadScene(scene) {
        if (!scene || loadingScene) return
        replayPanel?.clearPending()
        const wasPaused = clock?.state().paused
        loadingScene = true
        status.textContent = t('読み込み中…', 'Loading…')
        clock?.setPaused(true)
        refresh()
        try {
          await scene.load()
          if (clock) {
            if (scene.savedClock) clock.restoreState(scene.savedClock)
            else clock.reset?.()
            clock.setPaused(true)
          }
          currentScene = scene
          record(t(scene.label + 'を読み込む', 'Load ' + scene.label))
          status.textContent = ''
          return true
        } catch (error) {
          if (clock) clock.setPaused(wasPaused)
          status.textContent = error instanceof TuningRollbackError
            ? t('場面を読み込めませんでした。現在の調整値を確認してください', 'Could not load the scene. Check the current tuning values')
            : t('場面を読み込めませんでした', 'Could not load the scene')
        } finally {
          loadingScene = false
          select.value = currentScene?.id ?? ''
          refresh()
        }
      }

      function addSceneSaveForm() {
        const canRestoreClock = typeof clock?.restoreState === 'function'
        const storagePrefix = sceneSaves.storageKey ? sceneSaves.storageKey + '.scene.' : ''
        const saved = element('optgroup')
        saved.label = t('保存した場面', 'Saved scenes')
        const dialog = element('dialog')
        dialog.className = 'gdw-scene-save'
        dialog.setAttribute('aria-label', t('今の場面を保存', 'Save current scene'))
        const trigger = button(t('場面を保存…', 'Save scene…'), () => {
          dialogStatus.textContent = ''
          dialog.showModal()
          name.focus()
        })
        trigger.setAttribute('aria-haspopup', 'dialog')
        const form = element('form')
        const label = element('label', t('保存名', 'Save name'))
        const name = element('input')
        name.type = 'text'
        name.required = true
        name.maxLength = 60
        name.autocomplete = 'off'
        label.append(name)
        const save = element('button', t('保存', 'Save'))
        save.type = 'submit'
        const actions = element('div')
        actions.className = 'gdw-action-buttons'
        actions.append(save, button(t('キャンセル', 'Cancel'), () => dialog.close()))
        form.append(label, actions)
        dialog.append(element('h2', t('今の場面を保存', 'Save current scene')), form)
        const dialogStatus = notice(dialog)
        choices.append(trigger)
        panel.append(dialog)

        if (storagePrefix) {
          try {
            const storage = doc.defaultView.localStorage
            for (let index = 0; index < storage.length; index += 1) {
              const key = storage.key(index)
              if (!key?.startsWith(storagePrefix)) continue
              try {
                const entry = JSON.parse(storage.getItem(key))
                if (entry?.version === 1 && typeof entry.label === 'string' && entry.label.trim() &&
                    Object.hasOwn(entry, 'state') && !available.has(key)) addSavedScene(key, entry)
              } catch {}
            }
          } catch {}
        }

        controlsRefresh.push(() => {
          trigger.disabled = name.disabled = isLocked()
          save.disabled = isLocked()
        })
        form.addEventListener('submit', event => {
          event.preventDefault()
          if (isLocked()) return
          const label = name.value.trim()
          if (!label) {
            dialogStatus.textContent = t('保存名を入力してください', 'Enter a save name')
            return
          }
          if ([...available.values()].some(scene => scene.label === label)) {
            dialogStatus.textContent = t('同じ名前の場面があります。別の名前で保存してください', 'A scene with this name already exists. Use a different name')
            return
          }

          try {
            const state = sceneSaves.capture()
            const tuningValues = readTuning()
            if (typeof state?.then === 'function' || !validTuning(tuningValues)) throw new Error()
            if (canTransferState && sceneSaves.validateState(cloneRestoreData(state)) !== true) throw new Error()
            const timing = canRestoreClock ? clock.state() : null
            const clockState = timing ? { ticks: timing.ticks, rate: timing.rate } : null
            const payload = JSON.stringify({ version: 1, label, state, tuning: tuningValues, clock: clockState,
              ...(canTransferState ? { gameId: sceneSaves.gameId, stateVersion: sceneSaves.stateVersion } : {}),
            })
            const entry = JSON.parse(payload)
            if (!Object.hasOwn(entry, 'state')) throw new Error()
            const token = Array.from(doc.defaultView.crypto.getRandomValues(new Uint32Array(4)),
              number => number.toString(16).padStart(8, '0')).join('')
            const id = (storagePrefix || 'gdw-scene-') + token

            let persisted = false
            if (storagePrefix) {
              try {
                doc.defaultView.localStorage.setItem(id, payload)
                persisted = true
              } catch {}
            }

            currentScene = addSavedScene(id, entry)
            select.value = id
            name.value = ''
            dialog.close()
            record(t(label + 'を保存', 'Save ' + label))
            status.textContent = persisted
              ? t('「' + label + '」を保存しました', 'Saved “' + label + '”')
              : t('「' + label + '」はこのページを開いている間だけ使えます', '“' + label + '” is available while this page stays open')
            refresh()
          } catch {
            dialogStatus.textContent = t('場面を保存できませんでした', 'Could not save the scene')
          }
        })

        function addSavedScene(id, entry) {
          const scene = {
            id,
            label: entry.label,
            savedClock: canRestoreClock ? entry.clock : null,
            async load() {
              const timing = scene.savedClock
              if ((Object.hasOwn(entry, 'gameId') && entry.gameId !== sceneSaves.gameId) ||
                  (Object.hasOwn(entry, 'stateVersion') && entry.stateVersion !== sceneSaves.stateVersion)) {
                throw new Error(t('保存した作品または保存データの版が一致しません', 'The saved game or save version does not match'))
              }
              if (!validTuning(entry.tuning) || (timing && !validClockState(timing, clock))) {
                throw new Error(t('保存した値が現在の設定と一致しません', 'Saved values do not match the current configuration'))
              }
              const state = JSON.parse(JSON.stringify(entry.state))
              if (Object.hasOwn(entry, 'stateVersion') && typeof sceneSaves.validateState === 'function' &&
                  sceneSaves.validateState(cloneRestoreData(state)) !== true) {
                throw new Error(t('保存した作品の状態が無効です', 'Invalid saved game state'))
              }
              const undo = writeTuning(entry.tuning)
              try {
                await sceneSaves.restore(state)
              } catch (error) {
                if (!undo()) throw new TuningRollbackError()
                throw error
              }
            },
          }
          const option = element('option', entry.label)
          option.value = id
          if (!saved.parentNode) select.append(saved)
          saved.append(option)
          available.set(id, scene)
          return scene
        }

        registerRestoredScene = point => {
          if (!point.scene) return null
          return available.get(point.scene.id) ?? addSavedScene(point.scene.id, {
            label: point.scene.label, state: cloneRestoreData(point.state), tuning: { ...point.tuning }, clock: point.clock,
            gameId: point.gameId, stateVersion: point.stateVersion,
          })
        }
      }
    }

    if (tuning.length) {
      const panel = section(t('パラメータ', 'Parameters'), 'tuning')
      for (const control of tuning) {
        const row = element('div', control.label)
        row.className = 'gdw-tuning'
        const display = element('output')
        const input = element('input')
        input.type = 'range'
        input.min = control.min
        input.max = control.max
        input.step = control.step ?? 1
        input.setAttribute('aria-label', control.label)
        const format = control.format ?? String
        const logChange = () => {
          const value = format(control.read())
          record(t(control.label + 'を' + value + 'に変更', 'Set ' + control.label + ' to ' + value))
        }
        const number = numberEditor(control.label + t('（数値入力）', ' (numeric input)'), input.min, input.max, input.step, value => {
          if (isLocked()) return
          control.write(value)
          refresh()
          logChange()
        })
        const sync = () => {
          const value = control.read()
          input.value = String(value)
          number.sync(value, isLocked())
          if (control.format) {
            const formatted = String(format(value))
            if (display.textContent !== formatted) display.textContent = formatted
          }
        }
        input.addEventListener('input', () => {
          control.write(input.valueAsNumber)
          refresh()
        })
        input.addEventListener('change', logChange)
        const line = element('div')
        line.className = 'gdw-slider-line'
        line.append(input, number.input)
        if (control.format) row.append(display)
        row.append(line)
        panel.append(row)
        controlsRefresh.push(() => {
          input.disabled = isLocked()
          sync()
        })
      }
      controls.append(foldPanel(panel, true))
      if (tuningPresets) addTuningPresets()
    }

    function addTuningPresets() {
      const defaults = readTuning()
      const slots = ['A', 'B']

      const storageKey = tuningPresets.storageKey
      const panel = section(t('調整値の保存・比較', 'Save & compare tuning'), 'tuning-presets')
      const compare = element('details')
      compare.append(element('summary', t('A / B の違い', 'A / B differences')))
      const differences = element('ul')
      compare.append(differences)
      const applyButtons = new Map()
      const saveButtons = []

      if (storageKey) {
        try {
          const stored = JSON.parse(doc.defaultView.localStorage.getItem(storageKey))
          for (const slot of slots) {
            const values = stored?.[slot]
            if (validTuning(values)) profiles[slot] = values
          }
        } catch {}
      }

      for (const slot of slots) {
        const row = element('div')
        row.className = 'gdw-buttons gdw-profile-row'
        const save = button(t(slot + 'に保存', 'Save to ' + slot), () => {
          profiles[slot] = readTuning()
          syncProfiles()
          record(t(slot + 'に調整値を保存', 'Save tuning to ' + slot))
          status.textContent = t(slot + 'に保存しました', 'Saved to ' + slot)
          if (storageKey) {
            try {
              doc.defaultView.localStorage.setItem(storageKey, JSON.stringify(profiles))
            } catch {
              status.textContent = t('このページを開いている間、' + slot + 'に保存します', 'Saved to ' + slot + ' while this page stays open')
            }
          }
        })
        const apply = button(t(slot + 'を適用', 'Apply ' + slot), () => applyTuning(profiles[slot], t(slot + 'を適用', 'Apply ' + slot)))
        applyButtons.set(slot, apply)
        saveButtons.push(save)
        row.append(save, apply)
        panel.append(row)
      }

      const reset = button(t('既定値に戻す', 'Reset to defaults'), () => applyTuning(defaults, t('既定値に戻す', 'Reset to defaults')))
      reset.className = 'gdw-reset-tuning'
      panel.append(reset, compare)
      const status = notice(panel)
      controls.append(foldPanel(panel))
      syncProfiles()
      controlsRefresh.push(() => {
        for (const save of saveButtons) save.disabled = isLocked()
        for (const [slot, apply] of applyButtons) apply.disabled = isLocked() || !profiles[slot]
        reset.disabled = isLocked()
      })

      function syncProfiles() {
        differences.replaceChildren()
        if (profiles.A && profiles.B) {
          for (const control of tuning) {
            const key = tuningKey(control)
            const a = profiles.A[key]
            const b = profiles.B[key]
            if (a === b) continue
            const format = control.format ?? String
            differences.append(element('li', control.label + '　A ' + format(a) + ' / B ' + format(b)))
          }
          if (!differences.childElementCount) differences.append(element('li', t('AとBは同じ値です', 'A and B have the same values')))
        } else {
          differences.append(element('li', t('AとBの両方を保存すると比較できます', 'Save both A and B to compare them')))
        }
        for (const [slot, apply] of applyButtons) apply.disabled = !profiles[slot]
      }

      function applyTuning(values, label) {
        try {
          writeTuning(values)
          status.textContent = label + t('（完了）', ' (done)')
          record(label)
        } catch (error) {
          status.textContent = error.message
        }
        refresh()
      }
    }

    if (actions.length && (!actionsWhilePaused || clock)) {
      const panel = section(t('手動操作', 'Manual actions'), 'actions')
      const buttons = element('div')
      buttons.className = 'gdw-action-buttons'
      if (actionsHint) {
        const hint = element('p', actionsHint)
        hint.className = 'gdw-action-hint'
        panel.append(hint)
      }
      panel.append(buttons)
      const pauseHere = actionsWhilePaused && typeof clock?.setPaused === 'function'
      let lastAction
      if (pauseHere) {
        const pause = button(t('停止して試す', 'Pause to try'), () => setPaused(true))
        buttons.append(pause)
        controlsRefresh.push(() => { pause.disabled = isLocked() || clock.state().paused })
      }
      for (const action of actions) {
        const trigger = button(action.label, () => {
          const message = action.run()
          if (message !== false) {
            record(typeof message === 'string' ? message : action.label)
            lastAction = entries[0]
          }
          refresh()
        })
        buttons.append(trigger)
        controlsRefresh.push(() => {
          trigger.disabled = isLocked() || (actionsWhilePaused && !clock.state().paused) ||
            (action.enabled ? !action.enabled() : false)
        })
      }
      if (pauseHere) {
        if (typeof clock.step === 'function') {
          const step = frameButton(t('1コマ進む', 'Next frame'), advanceFrame)
          buttons.append(step)
          controlsRefresh.push(() => { step.disabled = isLocked() || !clock.state().paused })
        }
        const feedback = notice(panel)
        controlsRefresh.push(() => {
          const message = lastAction && entries[0] === lastAction ? lastAction.message :
            clock.state().paused ? t('停止中', 'Paused') : t('再生中', 'Playing')
          if (feedback.textContent !== message) feedback.textContent = message
        })
      }
      controls.append(foldPanel(panel, !controls.childElementCount))
    }

    let viewport = null
    let previewHeader = null
    if (viewports.length) {
      viewport = element('div')
      viewport.className = 'gdw-viewport'
      stage.classList.add('gdw-stage-scroll')
      stage.setAttribute('role', 'region')
      stage.setAttribute('aria-label', t('プレビュー', 'Preview'))
      previewHeader = element('div')
      previewHeader.className = 'gdw-preview-header'
      const select = labeledSelect(previewHeader, t('表示サイズ', 'Preview size'), [{ id: '', label: t('自動', 'Auto') }, ...viewports])
      stage.prepend(previewHeader)
      setViewport = id => {
        select.value = id
        currentViewport = viewports.find(size => size.id === id) ?? null
        viewport.classList.toggle('gdw-viewport-fixed', Boolean(currentViewport))
        if (currentViewport) previewBody.tabIndex = 0
        else previewBody.removeAttribute('tabindex')
        viewport.style.width = currentViewport ? currentViewport.width + 'px' : ''
        viewport.style.height = currentViewport ? currentViewport.height + 'px' : ''
      }
      select.addEventListener('change', () => {
        setViewport(select.value)
        record(t('表示サイズを' + (currentViewport?.label ?? t('自動', 'Auto')) + 'に変更', 'Set preview size to ' + (currentViewport?.label ?? 'Auto')))
      })
    }

    function getReproduction({ includeRestorePoint = true } = {}) {
      const timing = clock?.state() ?? null
      return {
        version: 1,
        scene: currentScene ? { id: currentScene.id, label: currentScene.label } : null,
        viewport: currentViewport ? {
          id: currentViewport.id, label: currentViewport.label,
          width: currentViewport.width, height: currentViewport.height,
        } : null,
        clock: timing ? { paused: timing.paused, rate: timing.rate, time: timing.time, ticks: timing.ticks } : null,
        tuning: readTuning(),
        state: reproduction.read?.() ?? null,
        events: entries.map(entry => ({ ...entry })),
        ...(canTransferState && includeRestorePoint ? { restorePoint: captureRestorePoint() } : {}),
      }
    }

    if (reproduction) {
      const panel = section(t('再現情報', 'Reproduction data'), 'reproduction')
      const manual = element('textarea')
      manual.readOnly = true
      manual.hidden = true
      manual.rows = 6
      manual.setAttribute('aria-label', t('再現情報のJSON', 'Reproduction JSON'))
      const status = notice(panel)
      let copying = false
      function copyButton(label, includeRestorePoint) {
        const trigger = button(label, async () => {
          if (copying || isLocked()) return
          copying = true
          const active = doc.activeElement === trigger
          manual.hidden = true
          try {
            const payload = JSON.stringify(getReproduction({ includeRestorePoint }), null, 2)
            refresh()
            try {
              await doc.defaultView.navigator.clipboard.writeText(payload)
              status.textContent = includeRestorePoint ? t('コピーしました', 'Copied') : t('診断情報をコピーしました', 'Diagnostic information copied')
            } catch {
              manual.value = payload
              manual.hidden = false
              manual.focus()
              manual.select()
              status.textContent = t('選択したJSONをコピーできます', 'Copy the selected JSON')
            }
          } catch (error) { status.textContent = t('情報を作成できませんでした。', 'Could not create the information. ') + error.message }
          finally {
            copying = false
            refresh()
            if (active && manual.hidden) trigger.focus()
          }
        })
        controlsRefresh.push(() => { trigger.disabled = copying || isLocked() })
        return trigger
      }
      panel.insertBefore(copyButton(canTransferState ? t('再現情報をコピー', 'Copy reproduction data') : t('診断情報をコピー', 'Copy diagnostics'), canTransferState), status)
      panel.append(manual)
      if (canTransferState) {
        const diagnostic = copyButton(t('診断情報だけをコピー', 'Copy diagnostics only'), false)
        panel.insertBefore(diagnostic, status)
        const disclosure = element('details')
        disclosure.append(element('summary', t('JSONを貼り付けて復元', 'Paste JSON to restore')))
        const input = element('textarea')
        input.rows = 6
        input.setAttribute('aria-label', t('復元するJSON', 'JSON to restore'))
        input.placeholder = t('再現情報のJSONを貼り付ける', 'Paste reproduction JSON')
        const restore = button(t('貼り付けて復元', 'Paste & restore'), async () => {
          if (isLocked()) return
          restore.disabled = true
          try {
            const information = JSON.parse(input.value)
            const point = information?.restorePoint ?? information
            await applyRestorePoint(point)
            record(t('貼り付けた状態を復元', 'Restore pasted state'))
            status.textContent = t('貼り付けた状態を復元しました（停止中）', 'Restored the pasted state (paused)')
          } catch (error) {
            status.textContent = error instanceof SyntaxError ? t('JSONを読み取れませんでした。現在の状態は変えていません', 'Could not parse the JSON. The current state is unchanged') : error.message
          } finally {
            restore.disabled = isLocked()
          }
        })
        const help = element('p', t('復元すると場面と調整値が切り替わります。', 'Restoring changes the scene and tuning values.'))
        help.className = 'gdw-save-scope'
        disclosure.append(help, input, restore)
        panel.append(disclosure)
        controlsRefresh.push(() => {
          input.disabled = isLocked()
          restore.disabled = isLocked()
        })
      }
      observer.append(foldPanel(panel))
    }

    const eventNames = new Map(events.map(event => [event.id, event.label]))
    let stopOn = ''
    let eventStatus
    if (events.length && typeof clock?.setPaused === 'function') {
      const panel = section(t('イベントで自動停止', 'Pause on event'), 'breakpoints')
      const choices = element('div')
      choices.className = 'gdw-choice-row'
      const select = labeledSelect(choices, t('停止条件', 'Pause condition'), [{ id: '', label: t('自動停止しない', 'Do not pause automatically') }, ...events])
      cardHeader(panel, choices)
      select.addEventListener('change', () => {
        if (seeking) clock.setPaused(true)
        seeking = false
        stopOn = select.value
        eventStatus.textContent = ''
        refresh()
      })
      let seeking = false
      const seek = typeof clock.seekEvent === 'function' && button(t('発生まで進む', 'Advance to event'), () => {
        seeking = true
        eventStatus.textContent = t('「' + eventNames.get(stopOn) + '」の発生まで進めています', 'Advancing until “' + eventNames.get(stopOn) + '” occurs')
        clock.seekEvent(() => {
          seeking = false
          eventStatus.textContent = t('ゲーム内で60秒進めても発生しなかったため、停止しました', 'Paused because the event did not occur within 60 seconds of game time')
          refresh()
        })
        refresh()
      })
      if (seek) choices.append(seek)
      eventStatus = notice(panel)
      controls.append(panel)
      controlsRefresh.push(() => {
        if (seeking && clock.state().paused) {
          seeking = false
          eventStatus.textContent = t('早送りを停止しました', 'Fast forward stopped')
        }
        select.disabled = isLocked()
        if (seek) seek.disabled = isLocked() || !stopOn || seeking
      })
    }

    function notifyEvent(id) {
      if (!eventNames.has(id)) return
      record(eventNames.get(id))
      if (stopOn === id && !isLocked()) {
        cancelFrameHold?.()
        clock.setPaused(true)
        refresh()
        eventStatus.textContent = t('「' + eventNames.get(id) + '」で停止しました', 'Paused at “' + eventNames.get(id) + '”')
      }
    }

    let workShortcut
    if (workPresets) addWorkPresets()
    function addWorkPresets() {
      if (!workPresets.storageKey?.trim()) throw new TypeError(t('作業プリセットに作品固有の保存キーが必要です', 'Workspace presets require a storage key unique to this game'))
      const prefix = workPresets.storageKey + '.work.'
      const presets = new Map()
      const persisted = new Set()
      const panel = section(t('作業環境', 'Workspace'), 'work-presets')
      const parts = [
        (canTransferState || scenes.length) && t('場面', 'Scene'), tuning.length && t('調整値', 'Tuning'),
        layout && t('カード配置', 'Card layout'), viewports.length && t('表示サイズ', 'Preview size'),
      ].filter(Boolean)
      if (parts.length) {
        const scope = element('p', t(parts.join('・') + 'をまとめて保存', 'Save ' + parts.join(', ') + ' together'))
        scope.className = 'gdw-save-scope'
        panel.append(scope)
      }
      const select = labeledSelect(panel, t('保存した作業環境', 'Saved workspace'), [{ id: '', label: t('選んで読み込む', 'Choose to load') }])
      function add(name, value) {
        presets.set(name, value)
        const option = element('option', name)
        option.value = name
        select.append(option)
      }
      try {
        const storage = doc.defaultView.localStorage
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i)
          if (!key?.startsWith(prefix)) continue
          try {
            const data = JSON.parse(storage.getItem(key))
            if (data?.version === 1) {
              const title = key.slice(prefix.length)
              add(title, data)
              persisted.add(title)
            }
          } catch {}
        }
      } catch {}

      const label = element('label', t('作業名', 'Workspace name'))
      label.className = 'gdw-select'
      const name = element('input')
      name.maxLength = 60
      label.append(name)
      const form = element('form')
      const save = element('button', t('作業環境を保存', 'Save workspace'))
      save.type = 'submit'
      form.append(label, save)
      const manage = element('details')
      const manageTitle = element('summary')
      let lastWork = ''
      const overwrite = button(t('現在の内容で上書き', 'Overwrite with current settings'), () => saveWork(lastWork, true))
      const remove = button(t('削除…', 'Delete…'), () => {
        confirmation.hidden = false
        confirmRemove.focus()
      })
      const confirmation = element('div')
      const confirmRemove = button(t('この作業を削除', 'Delete this workspace'), () => {
        if (isLocked() || !presets.has(lastWork)) return
        const title = lastWork
        try {
          if (persisted.has(title)) doc.defaultView.localStorage.removeItem(prefix + title)
        } catch {
          status.textContent = t('ブラウザの保存枠から削除できませんでした', 'Could not delete it from browser storage')
          return
        }
        persisted.delete(title)
        presets.delete(title)
        for (const option of select.options) {
          if (option.value === title) { option.remove(); break }
        }
        setLastWork('')
        status.textContent = t('「' + title + '」を削除しました', 'Deleted “' + title + '”')
        refresh()
        name.focus()
      })
      const cancel = button(t('キャンセル', 'Cancel'), () => {
        confirmation.hidden = true
        remove.focus()
      })
      confirmation.append(confirmRemove, cancel)
      manage.append(manageTitle, overwrite, remove, confirmation)
      manage.addEventListener('toggle', () => { if (!manage.open) confirmation.hidden = true })
      function setLastWork(title) {
        lastWork = title
        manageTitle.textContent = t('「' + title + '」の更新・削除', 'Update or delete “' + title + '”')
        manage.open = false
        manage.hidden = !title
        confirmation.hidden = true
      }
      setLastWork('')
      form.addEventListener('submit', event => {
        event.preventDefault()
        saveWork(name.value.trim(), false)
      })

      function saveWork(title, replace) {
        if (isLocked()) return
        if (!title || (!replace && presets.has(title))) {
          status.textContent = title ? t('同じ名前の作業があります', 'A workspace with this name already exists') : t('作業名を入力してください', 'Enter a workspace name')
          return
        }
        try {
          const open = {}
          for (const card of root.querySelectorAll('[data-gdw-card]')) {
            const fold = card.querySelector(':scope > details')
            if (fold) open[card.dataset.gdwCard] = fold.open
          }
          const data = {
            version: 1, scene: currentScene?.id ?? null, tuning: readTuning(),
            point: canTransferState ? captureRestorePoint() : null,
            layout: board?.captureLayout() ?? null, rows: board?.captureRows?.() ?? null, widths: board?.captureWidths?.() ?? null,
            hiddenCards: board?.captureHiddenCards?.() ?? null,
            heights: board?.captureHeights?.() ?? null, viewport: currentViewport?.id ?? '', open,
          }
          const encoded = JSON.stringify(data)
          if (replace) presets.set(title, JSON.parse(encoded))
          else add(title, JSON.parse(encoded))
          try {
            doc.defaultView.localStorage.setItem(prefix + title, encoded)
            persisted.add(title)
            status.textContent = t('「' + title + '」を保存しました', 'Saved “' + title + '”')
          } catch { status.textContent = t('「' + title + '」はこのページでのみ使えます', '“' + title + '” is available only on this page') }
          name.value = ''
          select.value = ''
          setLastWork(title)
          refresh()
        } catch (error) { status.textContent = error.message }
      }
      panel.append(form, manage)
      const status = notice(panel)
      controls.append(foldPanel(panel))
      workShortcut = button(t('作業環境', 'Workspace'), () => {
        panel.querySelector(':scope > details').open = true
        const target = presets.size ? select : name
        target.focus()
        target.scrollIntoView({ block: 'nearest' })
      })
      workShortcut.className = 'gdw-work-shortcut'
      controlsRefresh.push(() => {
        workShortcut.disabled = isLocked()
        overwrite.disabled = remove.disabled = confirmRemove.disabled = isLocked()
        select.disabled = isLocked() || !presets.size
        const placeholder = presets.size ? t('選んで読み込む', 'Choose to load') : t('保存した作業はありません', 'No saved workspaces')
        if (select.options[0].textContent !== placeholder) select.options[0].textContent = placeholder
        save.disabled = isLocked()
      })
      select.addEventListener('change', async () => {
        const title = select.value
        const data = presets.get(title)
        select.value = ''
        if (!data || isLocked()) return
        applyingWork = true
        refresh()
        try {
          if (!validTuning(data.tuning) || (data.viewport && !viewports.some(v => v.id === data.viewport))) {
            throw new Error(t('保存した調整値または表示サイズが現在の設定と一致しません', 'Saved tuning values or preview size do not match the current configuration'))
          }
          if (data.point) {
            validateRestorePoint(data.point)
            await applyRestorePoint(data.point)
          } else {
            if (data.scene && !available.has(data.scene)) throw new Error(t('保存した場面が見つかりません', 'The saved scene could not be found'))
            if (data.scene && !await selectScene(available.get(data.scene))) throw new Error(t('場面を読み込めませんでした', 'Could not load the scene'))
            writeTuning(data.tuning)
          }
          setViewport?.(data.viewport)
          if (board && data.layout) board.applyLayout(data.layout, data.widths, data.heights, data.rows, data.hiddenCards)
          for (const card of root.querySelectorAll('[data-gdw-card]')) {
            const fold = card.querySelector(':scope > details')
            const open = data.open?.[card.dataset.gdwCard]
            if (fold && typeof open === 'boolean') fold.open = open
          }
          setLastWork(title)
          record(t('作業環境「' + title + '」を読み込む', 'Load workspace “' + title + '”'))
          status.textContent = t('「' + title + '」を読み込みました', 'Loaded “' + title + '”')
        } catch (error) { status.textContent = error.message }
        finally {
          applyingWork = false
          refresh()
        }
      })
    }

    let unsubscribe
    if (replay?.deterministic === true && typeof replay.applyInput === 'function' &&
        canTransferState && tuning.length && tuningPresets && typeof clock?.onTick === 'function' &&
        scope.WorkbenchReplay) {
      replayPanel = scope.WorkbenchReplay.mount({
        locale: resolvedLocale,
        doc, preview, clock, update, replay, capture: captureRestorePoint, restore: applyRestorePoint,
        readTuning, writeTuning, readPresets: tuning.length && tuningPresets ? () => profiles : null,
        readState, section, foldPanel, button,
        element, controls, record, refresh, loading: () => loadingScene || applyingWork,
      })
      unsubscribe = clock.onTick(replayPanel.beforeTick, replayPanel.afterTick)
      controlsRefresh.push(replayPanel.refresh)
    }

    if (!controls.childElementCount) controls.hidden = true
    if (layout) {
      const top = element('div')
      const left = element('div')
      const bottom = element('div')
      bottom.dataset.gdwLane = 'bottom'
      top.dataset.gdwLane = 'top'
      left.dataset.gdwLane = 'left'
      controls.dataset.gdwLane = 'center'
      observer.dataset.gdwLane = 'right'
      controls.hidden = false
      stage.dataset.gdwCard = 'preview'
      stage.setAttribute('aria-label', t('プレビュー', 'Preview'))
      const heading = cardHeading(stage, t('プレビュー', 'Preview'), 'preview')
      heading.classList.add('gdw-preview-title')
      const titleBar = previewHeader ?? stage
      titleBar.prepend(heading)
      top.append(...['scenes', 'time'].map(id => controls.querySelector('[data-gdw-card="' + id + '"]')).filter(Boolean))
      left.append(stage)
      root.append(top, left, controls, observer, bottom)
    }
    preview.parentNode.insertBefore(root, preview)
    // iframeの読み込みに先立って保存済みの配置を適用する。
    board = layout ? scope.GameDebugBoard.mount(root, { ...layout, locale: resolvedLocale }) : null
    if (board && workShortcut) root.querySelector('.gdw-layout-main')?.append(workShortcut)
    if (viewport) {
      viewport.append(preview)
      previewBody.append(viewport)
    } else {
      previewBody.append(preview)
    }
    stage.append(previewBody)
    refresh()

    return {
      refresh,
      record,
      notifyEvent,
      ...(typeof replay?.applyInput === 'function' ? {
        input(value) {
          if (loadingScene || applyingWork) return false
          if (replayPanel) return replayPanel.input(value)
          replay.applyInput(value)
          return true
        },
      } : {}),
      ...(canTransferState ? {
        captureRestorePoint, validateRestorePoint,
        applyRestorePoint(point) {
          if (isLocked()) return Promise.reject(new Error(t('作業中は復元できません', 'Cannot restore while an operation is in progress')))
          return applyRestorePoint(point)
        },
      } : {}),
      ...(reproduction ? { getReproduction } : {}),
      destroy() {
        cancelFrameHold?.()
        unsubscribe?.()
        replayPanel?.destroy()
        board?.destroy()
        if (root.parentNode) root.replaceWith(preview)
      },
    }
  }

  const api = { resolveLocale, createPreviewClock, mountWorkbench }
  if (typeof module === 'object' && module.exports) module.exports = api
  else scope.GameDebugWorkbench = api
})(globalThis)
