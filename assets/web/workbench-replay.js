;(function (scope) {
  'use strict'

  // 時計の beforeTick / afterTick から呼ぶ。独自の時計や描画ループは作らない。
  function mount(ctx) {
    const locale = scope.GameDebugWorkbench?.resolveLocale(ctx.locale) ?? ctx.locale ?? 'ja'
    const t = (ja, en) => locale === 'ja' ? ja : en
    const { clock, replay, capture, restore, readTuning, writeTuning, readPresets,
      readState, element, button, section, controls } = ctx
    if (replay?.deterministic !== true || typeof replay.applyInput !== 'function' ||
        typeof capture !== 'function' || typeof restore !== 'function' ||
        typeof clock?.restoreState !== 'function') {
      throw new TypeError(t('入力再生には決定的な更新と、乱数を含む状態の保存・復元が必要です', 'Input replay requires deterministic updates and a restorable state that includes the random seed.'))
    }

    const panel = section(t('操作の記録・再生', 'Input recording and playback'), 'replay')
    const actions = element('div')
    actions.className = 'gdw-replay-actions'
    const status = element('p')
    status.className = 'gdw-status'
    status.setAttribute('role', 'status')
    const summary = element('p')
    summary.className = 'gdw-recording-summary'
    const compareHint = element('p')
    compareHint.className = 'gdw-compare-hint'
    const results = element('div')
    results.className = 'gdw-replay-results'
    panel.append(summary, actions, compareHint, status, results)
    controls.append(ctx.foldPanel(panel))

    const maxTicks = 18000
    const maxInputs = 10000
    let mode = 'idle'
    let recording = null
    let pending = []
    let run = null
    let rollback = null
    let operation = Promise.resolve()
    let generation = 0
    let destroyed = false
    let result = null

    function copy(value) {
      const json = JSON.stringify(value)
      if (json === undefined) throw new TypeError(t('入力や保存状態はJSONで保存できる値にしてください', 'Inputs and saved state must be JSON-serializable.'))
      return JSON.parse(json)
    }

    function snapshot() {
      const point = capture()
      if (typeof point?.then === 'function' || !Number.isSafeInteger(point?.clock?.ticks)) {
        throw new TypeError(t('入力再生には時計を含む同期の保存状態が必要です', 'Input replay needs a synchronous snapshot that includes the clock.'))
      }
      return copy(point)
    }

    function isBusy() { return mode !== 'idle' }
    function clearPending() { pending = [] }
    function playable() { return recording && recording.duration > 0 }
    function presets() { return readPresets?.() ?? {} }
    function locked() { return destroyed || Boolean(ctx.loading?.()) }
    function changed(message) {
      if (message) status.textContent = message
      refresh()
      ctx.refresh?.()
    }
    function log(message) { ctx.record?.(message) }

    function refresh() {
      const busy = isBusy()
      const unavailable = locked()
      recordButton.disabled = unavailable || busy
      stopButton.disabled = unavailable || mode !== 'recording'
      playButton.disabled = unavailable || busy || !playable()
      const profiles = presets()
      compareButton.disabled = unavailable || busy || !playable() || !profiles.A || !profiles.B
      const hint = profiles.A && profiles.B ? '' : t('A/B比較には「調整値の保存・比較」でAとBに保存します。', 'Save both A and B tuning presets before comparing them.')
      if (compareHint.textContent !== hint) compareHint.textContent = hint
      cancelButton.disabled = unavailable || !['preparing', 'playing', 'comparing'].includes(mode)
      const count = recording?.inputs.length ?? 0
      const ticks = mode === 'recording'
        ? clock.state().ticks - recording.start.clock.ticks : recording?.duration ?? 0
      summary.textContent = recording ? t(ticks + 'コマ / 操作' + count + '件', `Frames: ${ticks} / Inputs: ${count}`) : t('まだ操作は記録されていません', 'No inputs recorded yet.')
      if (mode === 'playing' || mode === 'comparing') {
        summary.textContent += t('　', ' · ') + (run.phase ? run.phase + t('：', ': ') : '') +
          (clock.state().ticks - recording.start.clock.ticks) + ' / ' + recording.duration + t('コマ', ' frames')
      }
    }

    function startRecording() {
      if (locked() || isBusy()) return false
      try {
        const start = snapshot()
        recording = { start, tuning: copy(readTuning()), inputs: [], duration: 0, expectedTick: start.clock.ticks }
        pending = []
        result = null
        results.replaceChildren()
        mode = 'recording'
        clock.setPaused(false)
        log(t('操作の記録を開始', 'Started recording inputs'))
        changed(t('記録中。操作は次のコマに反映されます', 'Recording. Inputs take effect on the next frame.'))
        return true
      } catch (error) {
        changed(error.message)
        return false
      }
    }

    function stopRecording(message = t('操作の記録を終了しました', 'Recording stopped.')) {
      if (mode !== 'recording') return false
      clock.setPaused(true)
      recording.duration = clock.state().ticks - recording.start.clock.ticks
      pending = []
      mode = 'idle'
      log(t('操作の記録を終了（' + recording.duration + 'コマ）', `Recording stopped after ${recording.duration} frames.`))
      changed(recording.duration ? message : t('1コマ以上進めてから記録を止めてください', 'Advance at least one frame before stopping the recording.'))
      return true
    }

    // ゲームからの入力は必ずここへ渡す。再生中の生入力は受け付けない。
    function input(value) {
      if (locked() || !['idle', 'recording'].includes(mode)) return false
      if (pending.length + (mode === 'recording' ? recording.inputs.length : 0) >= maxInputs) {
        if (mode === 'recording') stopRecording(t('入力が上限の' + maxInputs + '件に達したため停止しました', `Stopped at the limit of ${maxInputs} inputs.`))
        else changed(t('入力が多すぎます。次のコマが進むまでお待ちください', 'Too many inputs. Wait for the next frame.'))
        return false
      }
      try {
        JSON.stringify(value, (_key, entry) => {
          if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' ||
              (typeof entry === 'number' && !Number.isFinite(entry))) {
            throw new TypeError(t('入力にはJSONで変化せず保存できる値を使ってください', 'Inputs must survive a JSON round trip unchanged.'))
          }
          return entry
        })
        if (mode === 'idle' && clock.state().paused) {
          replay.applyInput(copy(value))
          ctx.refresh?.()
          return true
        }
        pending.push(copy(value))
        return true
      } catch (error) {
        changed(error.message)
        return false
      }
    }

    async function prepare(phase, token) {
      mode = 'preparing'
      clock.setPaused(true)
      changed(t((phase || '記録') + 'の開始状態を復元中', `Restoring the starting state for ${phase || 'the recording'}…`))
      await restore(copy(recording.start))
      if (destroyed || token !== generation) return
      writeTuning(copy(phase ? run.profiles[phase] : recording.tuning))
      if (clock.state().ticks !== recording.start.clock.ticks) {
        throw new Error(t('開始時の時計を復元できませんでした', 'Could not restore the starting clock.'))
      }
      run.phase = phase
      run.cursor = 0
      run.expectedTick = recording.start.clock.ticks
      mode = phase ? 'comparing' : 'playing'
      clock.setPaused(false)
      changed(phase ? t(phase + 'の調整値で同じ操作を再生中', `Playing the same inputs with preset ${phase}.`) : t('記録した操作を再生中', 'Playing recorded inputs.'))
    }

    async function fail(error, token) {
      if (token !== generation) return
      mode = 'preparing'
      clock.setPaused(true)
      pending = []
      let message = t('再生を停止しました。', 'Playback stopped. ') + error.message
      try {
        if (rollback) await restore(copy(rollback))
      } catch (rollbackError) {
        message += t('。開始前の状態への復元にも失敗しました：', '. Could not restore the previous state: ') + rollbackError.message
      }
      if (token !== generation) return
      clock.setPaused(true)
      run = null
      rollback = null
      mode = 'idle'
      log(message)
      changed(message)
    }

    function startPlayback(compare = false) {
      if (locked() || isBusy() || !playable()) return Promise.resolve(false)
      const token = ++generation
      try {
        const profiles = compare ? copy(presets()) : null
        if (compare && (!profiles.A || !profiles.B)) throw new Error(t('調整値のAとBを先に保存してください', 'Save tuning presets A and B first.'))
        rollback = snapshot()
        pending = []
        result = null
        results.replaceChildren()
        run = { profiles, phase: null, cursor: 0, expectedTick: 0, results: {} }
        operation = prepare(compare ? 'A' : null, token)
          .then(() => token === generation && !destroyed)
          .catch(async error => { await fail(error, token); return false })
      } catch (error) {
        run = null
        rollback = null
        changed(error.message)
        operation = Promise.resolve(false)
      }
      return operation
    }

    function beforeTick() {
      if (destroyed || ['preparing', 'canceling'].includes(mode)) return false
      try {
        const tick = clock.state().ticks
        if (mode === 'playing' || mode === 'comparing') {
          if (tick !== run.expectedTick || tick >= recording.start.clock.ticks + recording.duration) {
            throw new Error(t('再生中の時計が記録したコマからずれました', 'The playback clock drifted from the recorded frame.'))
          }
          const offset = tick - recording.start.clock.ticks
          while (run.cursor < recording.inputs.length && recording.inputs[run.cursor].tick === offset) {
            const entry = recording.inputs[run.cursor++]
            const applied = replay.applyInput(copy(entry.value))
            if (typeof applied?.then === 'function') throw new TypeError(t('入力の反映は同期で行ってください', 'Apply each input synchronously.'))
          }
        } else {
          if (mode === 'recording' && tick !== recording.expectedTick) {
            throw new Error(t('記録中にゲーム内時刻が変わりました。操作を記録し直してください', 'Game time changed during recording. Record the inputs again.'))
          }
          const inputs = pending.splice(0)
          for (const value of inputs) {
            if (mode === 'recording') {
              recording.inputs.push({ tick: tick - recording.start.clock.ticks, value: copy(value) })
            }
            const applied = replay.applyInput(value)
            if (typeof applied?.then === 'function') throw new TypeError(t('入力の反映は同期で行ってください', 'Apply each input synchronously.'))
          }
        }
        return true
      } catch (error) {
        if (mode === 'recording') {
          stopRecording(t('入力の反映に失敗しました：', 'Could not apply input: ') + error.message)
          recording = null
          refresh()
        }
        else if (run) operation = fail(error, generation)
        else changed(t('入力の反映に失敗しました：', 'Could not apply input: ') + error.message)
        clock.setPaused(true)
        return false
      }
    }

    function display(value) {
      if (value == null) return '—'
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
    }

    function showComparison() {
      const a = run.results.A
      const b = run.results.B
      result = copy({ ticks: recording.duration, endTick: clock.state().ticks, A: a, B: b,
        tuning: run.profiles })
      const heading = element('h3', t('同じ終了コマでの比較', 'Comparison at the same final frame'))
      const end = element('p', t(recording.duration + 'コマ後 / 終了コマ ' + clock.state().ticks, `Frames elapsed: ${recording.duration} / Final frame: ${clock.state().ticks}`))
      const list = element('dl')
      const labels = new Set([...Object.keys(a), ...Object.keys(b)])
      for (const label of labels) {
        const row = element('div')
        row.append(element('dt', label))
        const difference = typeof a[label] === 'number' && typeof b[label] === 'number'
          ? t(' / 差 ', ' / difference: ') + Number((b[label] - a[label]).toPrecision(10)) : ''
        row.append(element('dd', 'A ' + display(a[label]) + ' / B ' + display(b[label]) + difference))
        list.append(row)
      }
      if (!labels.size) list.append(element('dd', t('比較できる実行状態がありません', 'No game state available to compare.')))
      results.replaceChildren(heading, end, list)
    }

    function afterTick() {
      if (destroyed) return
      if (mode === 'recording') {
        recording.expectedTick += 1
        if (clock.state().ticks !== recording.expectedTick) {
          stopRecording(t('記録中にゲーム内時刻が変わりました。操作を記録し直してください', 'Game time changed during recording. Record the inputs again.'))
          recording = null
          refresh()
          return
        }
        const ticks = clock.state().ticks - recording.start.clock.ticks
        if (ticks >= maxTicks) stopRecording(t('記録が上限の' + maxTicks + 'コマに達したため停止しました', `Stopped recording at the limit of ${maxTicks} frames.`))
        return
      }
      if (mode !== 'playing' && mode !== 'comparing') return
      const token = generation
      try {
        run.expectedTick += 1
        if (clock.state().ticks !== run.expectedTick) throw new Error(t('再生中の時計が記録したコマからずれました', 'The playback clock drifted from the recorded frame.'))
        if (clock.state().ticks < recording.start.clock.ticks + recording.duration) return
        clock.setPaused(true)
        if (run.cursor !== recording.inputs.length) throw new Error(t('未再生の入力が残っています', 'Some recorded inputs have not been played.'))
        if (run.phase) {
          run.results[run.phase] = copy(readState?.() ?? {})
          if (run.phase === 'A') {
            operation = prepare('B', token).catch(error => fail(error, token))
            return
          }
          showComparison()
        }
        const compared = Boolean(run.phase)
        run = null
        rollback = null
        mode = 'idle'
        log(compared ? t('同じ操作でA/Bを比較しました', 'Compared A and B with the same inputs.') : t('記録した操作の再生が完了', 'Finished playing recorded inputs.'))
        changed(compared ? t('A/Bの比較が完了しました。プレビューはBの終了状態です', 'Comparison complete. The preview shows the final state for B.') : t('記録の終了コマで停止しました', 'Stopped at the last recorded frame.'))
      } catch (error) {
        operation = fail(error, token)
      }
    }

    function cancel() {
      if (mode === 'recording') return Promise.resolve(stopRecording())
      if (!isBusy() || mode === 'canceling') return operation
      ++generation
      clock.setPaused(true)
      mode = 'canceling'
      pending = []
      changed(t('再生前の状態に戻しています', 'Restoring the state before playback…'))
      const previous = operation
      operation = (async () => {
        let message = t('再生を中止し、再生前の状態に戻しました', 'Playback canceled. Previous state restored.')
        try {
          await previous
          if (rollback) await restore(copy(rollback))
        } catch (error) {
          message = t('中止後の復元に失敗しました：', 'Could not restore state after canceling: ') + error.message
        }
        clock.setPaused(true)
        mode = 'idle'
        run = null
        rollback = null
        changed(message)
      })()
      return operation
    }

    const recordButton = button(t('記録を開始', 'Start recording'), startRecording)
    const stopButton = button(t('記録を終了', 'Stop recording'), () => stopRecording())
    const playButton = button(t('記録を再生', 'Play recording'), () => startPlayback())
    const compareButton = button(t('同じ操作でA/B比較', 'Compare A/B with the same inputs'), () => startPlayback(true))
    const cancelButton = button(t('記録の再生を中止', 'Cancel playback'), cancel)
    const recordingActions = element('div')
    const playbackActions = element('div')
    recordingActions.append(recordButton, stopButton)
    playbackActions.append(playButton, cancelButton)
    actions.append(recordingActions, playbackActions)
    if (readPresets) actions.append(compareButton)
    else compareHint.hidden = true
    refresh()
    return {
      input, beforeTick, afterTick, isBusy, clearPending, refresh, cancel,
      startRecording, stopRecording, play: () => startPlayback(), compare: () => startPlayback(true),
      state: () => ({ mode, ticks: recording?.duration ?? 0, inputs: recording?.inputs.length ?? 0,
        result: result ? copy(result) : null }),
      destroy() {
        const completion = cancel()
        destroyed = true
        pending = []
        panel.remove()
        return completion
      },
    }
  }

  scope.WorkbenchReplay = { mount }
})(globalThis)
