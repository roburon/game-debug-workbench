;(function (scope) {
  'use strict'

  const STANDARD = 'standard'
  const CURRENT = 'current'
  const MIN_LANE_WIDTH = 120
  const MIN_BOARD_WIDTH = 240
  const MAX_BOARD_WIDTH = 16384
  const trackMinimums = { wide: { px: 155, percent: 20 }, pair: { px: 170, percent: 30 } }
  const laneNames = { top: '上段', left: '左列', center: '中央列', right: '右列', bottom: '下段' }

  function mount(root, { storageKey, heading, header, hiddenCards }) {
    const doc = root.ownerDocument
    const win = doc.defaultView
    const keyboard = new win.AbortController()
    const lanes = new Map([...root.querySelectorAll('[data-gdw-lane]')].map(lane => [lane.dataset.gdwLane, lane]))
    const cards = new Map([...root.querySelectorAll('[data-gdw-card]')].map(card => [card.dataset.gdwCard, card]))
    const laneIds = [...lanes.keys()]
    const canMovePreview = typeof root.moveBefore === 'function'
    const defaultLayout = Object.fromEntries([...lanes].map(([id, lane]) => [
      id, [...lane.children].map(card => card.dataset.gdwCard).filter(Boolean),
    ]))
    const previewLane = laneIds.find(id => defaultLayout[id].includes('preview'))
    const defaultHidden = normalizeHidden(hiddenCards)

    function normalizeHidden(value) {
      const keys = new Set(Array.isArray(value) ? value : [])
      return [...cards.keys()].filter(key => keys.has(key))
    }

    function readHidden(value) {
      return Array.isArray(value) ? normalizeHidden(value) : [...defaultHidden]
    }

    function cardVisible(card) {
      return !card.hidden && !card.hasAttribute('data-gdw-user-hidden')
    }

    function element(tag, text, className) {
      const node = doc.createElement(tag)
      if (text) node.textContent = text
      if (className) node.className = className
      return node
    }

    function button(text, action, label) {
      const node = element('button', text)
      node.type = 'button'
      if (label) node.setAttribute('aria-label', label)
      if (action) node.addEventListener('click', action)
      return node
    }

    function option(value, label) {
      const node = element('option', label)
      node.value = value
      return node
    }

    function normalizeLayout(saved) {
      const seen = new Set()
      const result = Object.fromEntries(laneIds.map(id => [id, []]))
      for (const id of laneIds) {
        if (!Array.isArray(saved?.[id])) continue
        for (const key of saved[id]) {
          if (!cards.has(key) || seen.has(key) || (!canMovePreview && key === 'preview' && id !== previewLane)) continue
          result[id].push(key)
          seen.add(key)
        }
      }
      for (const id of laneIds) {
        result[id].push(...defaultLayout[id].filter(key => !seen.has(key)))
      }
      return result
    }

    function defaultRows(id, keys) {
      const columns = id === 'top' || id === 'bottom' ? 2 : 1
      const rows = []
      for (let i = 0; i < keys.length; i += columns) rows.push(keys.slice(i, i + columns))
      return rows
    }

    // 従来の layout はカード順として残し、方向を指定した領域だけ行の区切りを保存する。
    function readRows(saved, layout) {
      const result = {}
      for (const id of laneIds) {
        if (!Array.isArray(saved?.[id])) continue
        const remaining = new Set(layout[id])
        const rows = []
        for (const group of saved[id]) {
          if (!Array.isArray(group)) continue
          const row = group.filter(key => remaining.delete(key))
          if (row.length) rows.push(row)
        }
        rows.push(...defaultRows(id, [...remaining]))
        if (rows.flat().every((key, i) => key === layout[id][i])) result[id] = rows
      }
      return result
    }

    function rowsFor(id) {
      return state.rows[id] ?? defaultRows(id, state.layout[id])
    }

    function sameRows(a, b) {
      return laneIds.every(id => JSON.stringify(a[id]) === JSON.stringify(b[id]))
    }

    // wide は左列の割合と、残りの幅のうち中央列が使う割合。
    function ratio(value) {
      return Number.isInteger(value) && value >= 20 && value <= 80
    }
    function validBoardWidth(value) {
      return Number.isSafeInteger(value) && value >= MIN_BOARD_WIDTH && value <= MAX_BOARD_WIDTH
    }
    function readWidths(saved) {
      // 境界のドラッグで決めた実寸も、従来と同じ配分に換算して保存する。
      const trackRatio = value => Number.isFinite(value) && value > 0 && value < 100
      const limits = {}
      const rows = {}
      for (const id of laneIds) {
        const entry = saved?.limits?.[id]
        if (Number.isSafeInteger(entry?.max) && entry.max >= MIN_LANE_WIDTH) {
          limits[id] = { max: entry.max, anchor: Number.isFinite(entry.anchor) ? Math.max(0, Math.min(1, entry.anchor)) : 0 }
        }
        if (Array.isArray(saved?.rows?.[id])) {
          const entries = []
          for (const row of saved.rows[id]) {
            if (!Array.isArray(row?.cards) || !Array.isArray(row.shares) || row.cards.length !== row.shares.length ||
              new Set(row.cards).size !== row.cards.length || !row.cards.every(key => typeof key === 'string') ||
              !row.shares.every(share => Number.isFinite(share) && share > 0)) continue
            // 旧「プレビューサイズ」など、外れたカードの分を除いて残りの幅の比率を保つ。
            const keys = row.cards.filter(key => cards.has(key))
            if (keys.length < 2) continue
            const weights = row.shares.filter((_, i) => cards.has(row.cards[i]))
            const total = weights.reduce((sum, share) => sum + share, 0)
            if (!Number.isFinite(total)) continue
            const shares = Math.abs(total - 1) < 1e-9 ? weights : weights.map(share => share / total)
            if (shares.some(share => share <= Number.EPSILON)) continue
            const entry = { cards: keys, shares }
            if (keys.length === row.cards.length && Number.isSafeInteger(row.min) && row.min >= 0) entry.min = row.min
            entries.push(entry)
            if (entries.length === cards.size) break
          }
          if (entries.length) rows[id] = entries
        }
      }
      return {
        limits,
        rows,
        board: validBoardWidth(saved?.board) ? saved.board : null,
        wide: Array.isArray(saved?.wide) && saved.wide.length === 2 && saved.wide.every(trackRatio)
          ? [...saved.wide] : null,
        pair: trackRatio(saved?.pair) ? saved.pair : null,
        top: ratio(saved?.top) ? saved.top : null,
        bottom: ratio(saved?.bottom) ? saved.bottom : null,
      }
    }

    function readHeights(saved) {
      return Object.fromEntries(laneIds.map(id => {
        const height = saved?.[id]
        return [id, Number.isSafeInteger(height) && height >= 80 && height <= 4000 ? height : null]
      }))
    }

    function readState() {
      const initial = { version: 1, base: STANDARD, layout: defaultLayout, rows: {}, widths: readWidths(), heights: readHeights(), hiddenCards: [...defaultHidden], presets: [] }
      try {
        const saved = JSON.parse(win.localStorage.getItem(storageKey))
        if (saved?.version !== 1 || !Array.isArray(saved.presets)) return initial
        const ids = new Set([STANDARD, CURRENT])
        const presets = []
        for (const preset of saved.presets) {
          if (typeof preset?.id !== 'string' || ids.has(preset.id) || typeof preset.name !== 'string' || !preset.name.trim()) continue
          ids.add(preset.id)
          const layout = normalizeLayout(preset.layout)
          presets.push({
            id: preset.id, name: preset.name.trim().slice(0, 40), layout, rows: readRows(preset.rows, layout),
            widths: readWidths(preset.widths), heights: readHeights(preset.heights),
            hiddenCards: readHidden(preset.hiddenCards),
          })
        }
        const base = presets.some(preset => preset.id === saved.base) ? saved.base : STANDARD
        const layout = normalizeLayout(saved.layout)
        return { version: 1, base, layout, rows: readRows(saved.rows, layout), widths: readWidths(saved.widths), heights: readHeights(saved.heights), hiddenCards: readHidden(saved.hiddenCards), presets }
      } catch {
        return initial
      }
    }

    let state = readState()
    let lastFixedWidth = state.widths.board
    let editing = false
    let drag = null
    let marker = null
    let scrollFrame = 0
    let cueFrame = 0
    let geometryDirty = true
    let sizeDrag = null
    let previousLayout = null
    const cues = new Map()
    const bar = element('div', '', 'gdw-layout-bar')
    const barMain = element('div', '', 'gdw-layout-main')
    const selectLabel = element('label', '配置', 'gdw-layout-select')
    const select = element('select')
    select.setAttribute('aria-label', '配置プリセット')
    selectLabel.append(select)
    const boardSizing = element('div', '', 'gdw-board-sizing')
    const modeLabel = element('label', '盤面幅')
    const widthMode = element('select')
    widthMode.setAttribute('aria-label', '盤面幅')
    widthMode.append(option('fit', 'ウィンドウに合わせる'), option('fixed', '固定幅'))
    modeLabel.append(widthMode)
    const pixels = element('label', '', 'gdw-board-pixels')
    const widthInput = element('input')
    widthInput.type = 'number'
    widthInput.min = String(MIN_BOARD_WIDTH)
    widthInput.max = String(MAX_BOARD_WIDTH)
    widthInput.step = '1'
    widthInput.required = true
    widthInput.setAttribute('aria-label', '固定する盤面幅')
    pixels.append(widthInput, 'px')
    boardSizing.append(modeLabel, pixels)
    const edit = button('配置を編集', () => setEditing(!editing))
    edit.className = 'gdw-layout-toggle'
    edit.setAttribute('aria-expanded', 'false')
    const visibility = element('dialog', '', 'gdw-placement-picker gdw-visibility')
    visibility.setAttribute('aria-label', '表示するカード')
    const chooseCards = button('表示するカード', () => {
      for (const [key, check] of checks) check.parentElement.hidden = cards.get(key).hidden
      visibility.showModal()
    })
    chooseCards.className = 'gdw-card-picker'
    chooseCards.setAttribute('aria-haspopup', 'dialog')
    const options = element('div', '', 'gdw-visibility-options')
    const checks = new Map()
    const groups = new Map()
    for (const [key, card] of cards) {
      const genre = card.querySelector('.gdw-genre-name')?.textContent ?? 'カード'
      if (!groups.has(genre)) {
        const group = element('fieldset')
        group.append(element('legend', genre))
        groups.set(genre, group)
        options.append(group)
      }
      const check = element('input')
      check.type = 'checkbox'
      const label = element('label')
      label.append(check, card.getAttribute('aria-label') ?? key)
      groups.get(genre).append(label)
      checks.set(key, check)
      check.addEventListener('change', () => {
        const hidden = [...checks].filter(([, item]) => !item.checked).map(([id]) => id)
        commit({ ...state, hiddenCards: hidden }, '')
      })
    }
    const visibilityActions = element('div', '', 'gdw-picker-actions')
    const showAll = button('すべて表示', () => commit({ ...state, hiddenCards: [] }, ''))
    visibilityActions.append(showAll, button('閉じる', () => visibility.close()))
    visibility.append(element('h2', '表示するカード'), options, visibilityActions)
    const undo = button('元の配置に戻す', restoreLayout)
    undo.className = 'gdw-layout-undo'
    undo.disabled = true
    undo.title = '配置や作業環境を切り替える前のカード配置・幅・高さに戻します。ゲームの状態はそのままです。'
    undo.setAttribute('aria-label', '元の配置に戻す（ゲームの状態は戻しません）')
    const undoHint = element('span', 'ゲームの状態はそのまま', 'gdw-layout-undo-hint')
    undoHint.hidden = true
    const message = element('p', '', 'gdw-layout-status')
    let messageTimer = 0
    message.setAttribute('role', 'status')
    if (heading) barMain.append(heading)
    barMain.append(selectLabel, edit, chooseCards, boardSizing, undo, undoHint)
    const form = element('form', '', 'gdw-layout-form')
    const name = element('input')
    name.maxLength = 40
    name.placeholder = '配置名'
    name.autocomplete = 'off'
    name.setAttribute('aria-label', '配置名')
    const save = element('button', '配置を新規保存')
    save.type = 'submit'
    const update = button('配置を上書き保存', updatePreset)
    form.append(name, save, update)
    form.hidden = true
    const placementHint = element('p', '見出しをつかむとカードを移動できます。左右の辺とカードの境目で幅を、下の辺で高さを調整できます。', 'gdw-placement-hint')
    placementHint.hidden = true
    const headerAnchor = header?.parentNode ? doc.createComment('盤面ヘッダーの元の位置') : null
    if (headerAnchor) header.before(headerAnchor)
    bar.append(barMain, form, placementHint, message, visibility)
    const headerTools = header ? setupHeader() : null
    root.prepend(bar)
    root.classList.add('gdw-custom-board')
    const scrollArea = element('div', '', 'gdw-board-scroll')
    const surface = element('div', '', 'gdw-board-surface')
    root.before(scrollArea)
    scrollArea.append(surface)
    if (root.isConnected && typeof surface.moveBefore === 'function') surface.moveBefore(root, null)
    else surface.append(root)

    function setupHeader() {
      bar.classList.add('gdw-inline-bar')
      const row = element('div', '', 'gdw-header-row')
      const menu = element('dialog', '', 'gdw-placement-picker gdw-header-menu')
      menu.setAttribute('aria-label', 'メニュー')
      const menuButton = button('メニュー', () => {
        menu.showModal()
        menuButton.setAttribute('aria-expanded', 'true')
      })
      menuButton.setAttribute('aria-haspopup', 'dialog')
      menuButton.setAttribute('aria-expanded', 'false')
      menuButton.hidden = true
      const menuEnd = element('div', '', 'gdw-picker-actions')
      menuEnd.append(button('閉じる', () => menu.close()))
      menu.append(element('h2', 'メニュー'), menuEnd)
      const nav = header.querySelector('nav')
      const navAnchor = nav ? doc.createComment('ゲーム切り替えの位置') : null
      if (nav) nav.before(navAnchor)
      const pageName = nav?.querySelector('[aria-current="page"]')?.textContent.trim()
      const compactTitle = pageName && header.querySelector(':scope > h1') ? element('span', pageName, 'gdw-current-page') : null
      if (compactTitle) header.append(compactTitle)

      const saveDialog = element('dialog', '', 'gdw-placement-picker gdw-header-save')
      saveDialog.setAttribute('aria-label', '配置を保存')
      const saveButton = button('配置を保存…', () => {
        if (menu.open) menu.close()
        saveDialog.showModal()
        name.focus()
      })
      saveButton.setAttribute('aria-haspopup', 'dialog')
      saveButton.hidden = true
      barMain.insertBefore(saveButton, undo)
      const saveEnd = element('div', '', 'gdw-picker-actions')
      saveEnd.append(button('閉じる', () => saveDialog.close()))
      saveDialog.append(element('h2', '配置を保存'), form, saveEnd)
      edit.title = placementHint.textContent
      const editTools = element('div', '', 'gdw-mobile-edit-tools')
      editTools.append(button('配置を保存…', () => saveButton.click()), button('編集を完了', () => setEditing(false)))
      row.append(header, barMain, chooseCards, editTools, menuButton)
      bar.prepend(row)
      bar.append(menu, saveDialog)

      let wideMinimum = 0
      function fit(force = false) {
        const width = row.clientWidth
        if (!width || menu.open || saveDialog.open) return
        const focused = doc.activeElement
        const wasCompact = !menuButton.hidden
        if (!wasCompact || width >= wideMinimum || force) {
          header.classList.remove('gdw-show-current-page')
          if (nav && nav.parentNode !== navAnchor.parentNode) navAnchor.after(nav)
          if (chooseCards.parentNode !== row) row.insertBefore(chooseCards, editTools)
          if (barMain.parentNode !== row) row.insertBefore(barMain, chooseCards)
          row.classList.remove('gdw-header-compact')
          menuButton.hidden = true
          if (row.scrollWidth > width + 1) {
            wideMinimum = row.scrollWidth
            menu.insertBefore(barMain, menuEnd)
            menuButton.hidden = false
            row.classList.add('gdw-header-compact')
          }
        }
        if (!menuButton.hidden && editing && chooseCards.parentNode !== menu) menu.insertBefore(chooseCards, menuEnd)
        if (nav && !menuButton.hidden) {
          if (width < 620 && nav.parentNode !== menu) menu.insertBefore(nav, barMain)
          if (width >= 620 && nav.parentNode === menu) navAnchor.after(nav)
        }
        header.classList.toggle('gdw-show-current-page', Boolean(compactTitle && nav.parentNode === menu))
        if (!menuButton.hidden && menu.contains(focused)) menuButton.focus({ preventScroll: true })
        else if (menuButton.hidden && focused === menuButton) edit.focus({ preventScroll: true })
      }

      menu.addEventListener('click', event => {
        if (event.target.closest('.gdw-work-shortcut, .gdw-layout-toggle')) menu.close()
      }, true)
      const size = new win.ResizeObserver(() => fit())
      size.observe(row)
      size.observe(barMain)
      function afterClose() {
        if (message.parentNode !== bar) {
          message.textContent = ''
          bar.append(message)
        }
        fit()
      }
      menu.addEventListener('close', () => {
        menuButton.setAttribute('aria-expanded', String(menu.open))
        afterClose()
      })
      saveDialog.addEventListener('close', () => {
        afterClose()
        if (!menuButton.hidden && !menu.open && doc.activeElement === doc.body) {
          menuButton.focus({ preventScroll: true })
        }
      })
      return {
        fit, menu, saveDialog, saveButton,
        destroy() {
          size.disconnect()
          if (menu.open) menu.close()
          if (saveDialog.open) saveDialog.close()
          if (navAnchor) navAnchor.replaceWith(nav)
          compactTitle?.remove()
          header.classList.remove('gdw-show-current-page')
        },
      }
    }

    widthMode.addEventListener('change', () => {
      const measured = Math.round(root.getBoundingClientRect().width)
      const board = widthMode.value === 'fit' ? null : lastFixedWidth ?? Math.min(MAX_BOARD_WIDTH, Math.max(MIN_BOARD_WIDTH, measured))
      commit({ ...state, widths: { ...state.widths, board } }, '', false)
    })
    function acceptWidth() {
      const board = widthInput.valueAsNumber
      if (widthInput.disabled) return
      if (!validBoardWidth(board)) {
        widthInput.value = state.widths.board
        report('固定幅には' + MIN_BOARD_WIDTH + '〜' + MAX_BOARD_WIDTH + 'pxの整数を入力してください。')
        return
      }
      if (board !== state.widths.board) commit({ ...state, widths: { ...state.widths, board } }, '', false)
    }
    widthInput.addEventListener('change', acceptWidth)
    widthInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        if (widthInput.reportValidity()) acceptWidth()
      } else if (event.key === 'Escape') {
        widthInput.value = state.widths.board
      }
    })

    function syncAvailableWidth() {
      const available = scrollArea.clientWidth
      root.style.setProperty('--gdw-visible-width', available + 'px')
      if (state.widths.board == null) widthInput.value = available
    }

    function applyBoardWidth() {
      const fixed = state.widths.board
      widthMode.value = fixed == null ? 'fit' : 'fixed'
      widthInput.disabled = fixed == null
      scrollArea.classList.toggle('gdw-board-fixed', fixed != null)
      if (fixed == null) {
        surface.style.removeProperty('width')
        scrollArea.scrollLeft = 0
      } else {
        surface.style.width = fixed + 'px'
        widthInput.value = fixed
        lastFixedWidth = fixed
      }
      syncAvailableWidth()
    }

    // 各領域の外にハンドルを置き、カードの配置や領域内のスクロールから独立させる。
    const boundaries = new Map()
    const resetDialog = element('dialog', '', 'gdw-placement-picker gdw-size-reset')
    resetDialog.setAttribute('aria-label', 'サイズを戻す')
    bar.append(resetDialog)
    for (const [id, lane] of lanes) {
      const boundary = element('div', '', 'gdw-width-boundary')
      boundary.dataset.gdwSizeLane = id
      boundary.style.gridColumn = win.getComputedStyle(lane).gridColumn
      boundary.hidden = true
      const title = laneNames[id] ?? id
      const handles = {}
      for (const edge of ['left', 'right', 'bottom']) {
        const height = edge === 'bottom'
        const handle = element('div', '', height ? 'gdw-height-edge' : 'gdw-width-edge')
        if (height) handle.dataset.gdwHeightEdge = ''
        else handle.dataset.gdwWidthEdge = edge
        const label = title + ({ left: 'の左端', right: 'の右端', bottom: 'の下端' })[edge]
        handle.setAttribute('role', 'separator')
        handle.setAttribute('aria-orientation', height ? 'horizontal' : 'vertical')
        handle.setAttribute('aria-label', label)
        handle.title = label + (height ? 'を引いて高さの上限を調整' : 'を引いて幅を調整') + '。Homeで解除、ダブルクリックでサイズを戻す'
        handle.setAttribute('aria-keyshortcuts', height ? 'ArrowUp ArrowDown Home Escape' : 'ArrowLeft ArrowRight Home Escape')
        handle.tabIndex = 0
        handles[edge] = handle
        boundary.append(handle)
        attachSizeEdge(id, handle, edge)
      }
      const reset = button('戻す…', () => openSizeReset(id), title + 'のサイズを戻す')
      reset.className = 'gdw-lane-reset'
      reset.setAttribute('aria-haspopup', 'dialog')
      const readout = element('span', '', 'gdw-width-readout')
      readout.hidden = true
      boundary.append(reset, readout)
      root.append(boundary)
      boundaries.set(id, { lane, boundary, handles, reset, readout })
    }
    const rowDividers = setupRowDividers()

    function sizeMode(id, count) {
      if (id === 'top' || id === 'bottom') return id
      if (count === 3 && ['left', 'center', 'right'].includes(id)) return 'wide'
      if (count === 2 && ['center', 'right'].includes(id)) return 'pair'
      return null
    }

    function resetSize(id, kind) {
      function focusHandle() {
        rowDividers.refresh()
        const row = [...root.querySelectorAll('.gdw-row-divider')].find(handle =>
          handle.dataset.gdwRowDivider === id && !handle.hidden)
        const target = kind === 'height' ? boundaries.get(id)?.handles.bottom :
          (kind === 'rows' || kind === 'top' || kind === 'bottom') && row ? row : boundaries.get(id)?.handles.right
        target?.focus({ preventScroll: true })
      }
      if (kind === 'height') {
        commit({ ...state, heights: { ...state.heights, [id]: null } }, null, false)
        focusHandle()
        return
      }
      const widths = readWidths(state.widths)
      if (kind === 'limit') delete widths.limits[id]
      else if (kind === 'rows') delete widths.rows[id]
      else widths[kind] = null
      commit({ ...state, widths }, null, false)
      focusHandle()
    }

    function openSizeReset(id) {
      if (resetDialog.open) return
      const title = laneNames[id] ?? id
      const actions = element('div', '', 'gdw-picker-actions')
      function add(label, kind) {
        actions.append(button(label, () => {
          resetDialog.close()
          resetSize(id, kind)
        }))
      }
      const mode = sizeMode(id, gridTracks().length)
      if (state.widths.limits[id]) add('幅の上限を解除', 'limit')
      if (state.heights[id] != null) add('高さの上限を解除', 'height')
      if (mode && state.widths[mode] != null) add('列幅を標準に戻す', mode)
      if (state.widths.rows?.[id]?.length) add('カード間の幅を標準に戻す', 'rows')
      actions.append(button('閉じる', () => resetDialog.close()))
      resetDialog.replaceChildren(element('h2', title + 'のサイズを戻す'), actions)
      resetDialog.showModal()
    }

    function findPreset(id) {
      return state.presets.find(preset => preset.id === id)
    }

    function selectLayout(id) {
      return findPreset(id)?.layout ?? defaultLayout
    }

    function layoutsMatch(a, b) {
      return laneIds.every(id => a[id].length === b[id].length && a[id].every((key, index) => key === b[id][index]))
    }

    function applyWidths() {
      applyBoardWidth()
      renderRows()
      paintWidths()
    }

    function displayedWidths() {
      return sizeDrag?.draft ?? state.widths
    }

    function paintWidths(widths = displayedWidths()) {
      const { wide, pair, top, bottom } = widths
      function columns(values, minimum = trackMinimums.pair) {
        const min = 'min(' + minimum.px + 'px, ' + minimum.percent + '%)'
        return values.map(value => 'minmax(' + min + ', ' + value + 'fr)').join(' ')
      }
      function set(name, value) {
        if (value) root.style.setProperty(name, value)
        else root.style.removeProperty(name)
      }
      set('--gdw-wide', wide && columns([wide[0], (100 - wide[0]) * wide[1] / 100,
        (100 - wide[0]) * (100 - wide[1]) / 100], trackMinimums.wide))
      set('--gdw-pair', pair && columns([pair, 100 - pair]))
      set('--gdw-top', top && columns([top, 100 - top]))
      set('--gdw-bottom', bottom && columns([bottom, 100 - bottom]))
      applyWidthLimits()
    }

    // グリッドの同じ行に置いたカードの左右を割り当てる。カードを領域の直下に
    // 保つことで、行の区切りや幅の変更だけで iframe を付け直すことはない。
    function renderRows(widths = displayedWidths()) {
      for (const [id, lane] of lanes) {
        lane.classList.toggle('gdw-custom-rows', Boolean(state.rows[id]))
        if (!state.rows[id]) continue
        let rowNumber = editing ? 2 : 1
        let minWidth = 0
        for (const group of state.rows[id]) {
          const visible = group.filter(key => cardVisible(cards.get(key)))
          const count = visible.length
          if (!count) continue
          const firstPair = (id === 'top' || id === 'bottom') ? (widths[id] ?? 50) / 100 : 0.5
          const saved = widths.rows?.[id]?.find(row => row.cards.length === group.length &&
            row.cards.every((key, index) => key === group[index]))
          const visibleTotal = saved && visible.reduce((sum, key) => sum + saved.shares[group.indexOf(key)], 0)
          let baseline = 0
          let start = 0
          visible.forEach((key, i) => {
            let initialShare = 1 / count
            if (count > 1 && i < 2) initialShare *= 2 * (i === 0 ? firstPair : 1 - firstPair)
            const share = saved ? saved.shares[group.indexOf(key)] / visibleTotal : initialShare
            if (count > 1) {
              baseline = Math.max(baseline, Math.ceil(156 / initialShare))
              minWidth = Math.max(minWidth, Math.ceil((saved ? 120 : 156) / share))
            }
            const card = cards.get(key)
            const end = start + share
            card.style.setProperty('--gdw-card-row', rowNumber)
            card.style.setProperty('--gdw-card-start', i ? 'calc(' + (start * 100) + '% + 4px)' : '0px')
            card.style.setProperty('--gdw-card-end', i + 1 < count ? 'calc(' + ((1 - end) * 100) + '% + 4px)' : '0px')
            start = end
          })
          if (saved) minWidth = Math.max(minWidth, count === group.length ? saved.min ?? baseline : baseline)
          rowNumber++
        }
        lane.style.setProperty('--gdw-row-min', minWidth + 'px')
      }
    }

    function gridTracks() {
      return win.getComputedStyle(root).gridTemplateColumns.split(' ').map(parseFloat)
    }

    function applyWidthLimits() {
      for (const [id, lane] of lanes) {
        const limit = displayedWidths().limits[id]
        lane.classList.toggle('gdw-width-capped', Boolean(limit))
        if (limit) {
          lane.style.setProperty('--gdw-lane-width', limit.max + 'px')
          lane.style.setProperty('--gdw-lane-anchor', limit.anchor)
        } else {
          lane.style.removeProperty('--gdw-lane-width')
          lane.style.removeProperty('--gdw-lane-anchor')
        }
      }
      scheduleCues()
    }

    function applyHeights() {
      for (const [id, lane] of lanes) {
        const preview = sizeDrag?.id === id && sizeDrag.edge === 'bottom' ? sizeDrag.height : null
        const height = preview ?? state.heights[id]
        lane.classList.toggle('gdw-capped', height != null)
        if (height == null) lane.style.removeProperty('--gdw-height')
        else lane.style.setProperty('--gdw-height', height + 'px')
      }
      scheduleCues()
    }

    function refreshMenu() {
      const base = findPreset(state.base)
      const changed = !layoutsMatch(state.layout, selectLayout(state.base)) || !sameRows(state.rows, base?.rows ?? {}) ||
        JSON.stringify(state.hiddenCards) !== JSON.stringify(base?.hiddenCards ?? defaultHidden) ||
        JSON.stringify(state.widths) !== JSON.stringify(base?.widths ?? readWidths()) ||
        JSON.stringify(state.heights) !== JSON.stringify(base?.heights ?? readHeights())
      select.replaceChildren(option(STANDARD, '標準配置'), ...state.presets.map(preset => option(preset.id, preset.name)))
      if (changed) {
        select.append(option(CURRENT, '現在の配置'))
      }
      select.value = changed ? CURRENT : state.base
      update.hidden = !base
      update.disabled = !changed
      if (base) update.setAttribute('aria-label', base.name + 'に上書き保存')
    }

    function report(text) {
      if (headerTools) {
        const parent = [headerTools.saveDialog, headerTools.menu].find(dialog => dialog.open) ?? bar
        if (message.parentNode !== parent) parent.append(message)
        win.clearTimeout(messageTimer)
        if (text && parent === bar) messageTimer = win.setTimeout(() => { message.textContent = '' }, 5000)
      }
      message.textContent = text
    }

    function layoutSnapshot() {
      return { base: state.base, layout: normalizeLayout(state.layout), rows: readRows(state.rows, state.layout), widths: readWidths(state.widths), heights: readHeights(state.heights), hiddenCards: [...state.hiddenCards] }
    }

    function rememberLayout(next) {
      if (layoutsMatch(next.layout, state.layout) && sameRows(next.rows, state.rows) && JSON.stringify(next.widths) === JSON.stringify(state.widths) &&
          JSON.stringify(next.hiddenCards) === JSON.stringify(state.hiddenCards) &&
          JSON.stringify(next.heights) === JSON.stringify(state.heights)) return
      previousLayout = layoutSnapshot()
      undo.disabled = false
      undoHint.hidden = false
    }

    function restoreLayout() {
      if (!previousLayout) return
      const previous = previousLayout
      previousLayout = null
      undo.disabled = true
      undoHint.hidden = true
      commit({ ...state, ...previous }, 'カード・幅・高さを戻しました。ゲームの状態は戻していません。')
    }

    function commit(next, success, place = true) {
      finishSizeDrag(false)
      rowDividers.cancel()
      if (next.rows !== state.rows && Object.keys(next.widths.rows).length) {
        // カードを組み替えた行の配分だけ外す。名前を付けて保存した配置は別に保持する。
        const kept = {}
        for (const [id, entries] of Object.entries(next.widths.rows)) {
          const groups = next.rows[id] ?? []
          const matches = entries.filter(row => groups.some(group =>
            group.length === row.cards.length && group.every((key, index) => key === row.cards[index])))
          if (matches.length) kept[id] = matches
        }
        next = { ...next, widths: { ...next.widths, rows: kept } }
      }
      if (next.hiddenCards !== state.hiddenCards) syncVisibility(next.hiddenCards)
      state = next
      let persisted = true
      try {
        win.localStorage.setItem(storageKey, JSON.stringify(next))
      } catch {
        persisted = false
      }
      applyWidths()
      applyHeights()
      refreshMenu()
      if (place) placeCards()
      if (!persisted) report('ブラウザに保存できません。このページを開いている間は使えます。')
      else if (success !== null) report(success)
    }

    function syncVisibility(hidden) {
      for (const [key, check] of checks) {
        check.checked = !hidden.includes(key)
        cards.get(key).toggleAttribute('data-gdw-user-hidden', !check.checked)
      }
      showAll.disabled = !hidden.length
    }

    select.addEventListener('change', () => {
      const id = select.value
      if (id === CURRENT) return
      const preset = findPreset(id)
      const next = { ...state, base: id, layout: selectLayout(id), rows: preset?.rows ?? {}, widths: readWidths(preset?.widths), heights: readHeights(preset?.heights), hiddenCards: readHidden(preset?.hiddenCards) }
      rememberLayout(next)
      commit(next, '')
    })

    form.addEventListener('submit', event => {
      event.preventDefault()
      const title = name.value.trim()
      if (!title) {
        report('配置名を入力してください。')
        name.focus()
        return
      }
      if (state.presets.some(preset => preset.name.toLowerCase() === title.toLowerCase())) {
        report('同じ名前の配置があります。')
        name.focus()
        return
      }
      const id = win.crypto.getRandomValues(new Uint32Array(4)).join('-')
      const preset = { id, name: title, layout: state.layout, rows: state.rows, widths: readWidths(state.widths), heights: readHeights(state.heights), hiddenCards: [...state.hiddenCards] }
      headerTools?.saveDialog.close()
      commit({ ...state, base: id, presets: [...state.presets, preset] }, '配置を保存しました。', false)
      name.value = ''
    })

    function updatePreset() {
      const preset = findPreset(state.base)
      if (!preset) return
      const updated = { ...preset, layout: state.layout, rows: state.rows, widths: readWidths(state.widths), heights: readHeights(state.heights), hiddenCards: [...state.hiddenCards] }
      const presets = state.presets.map(entry => entry.id === preset.id ? updated : entry)
      headerTools?.saveDialog.close()
      commit({ ...state, presets }, '「' + preset.name + '」を更新しました。', false)
    }

    function setEditing(enabled) {
      finishSizeDrag(false)
      rowDividers.cancel()
      stopDrag()
      editing = enabled
      root.classList.toggle('gdw-layout-editing', enabled)
      edit.textContent = enabled ? '編集を完了' : '配置を編集'
      edit.setAttribute('aria-expanded', String(enabled))
      form.hidden = !enabled
      if (headerTools) {
        headerTools.saveButton.hidden = !enabled
        headerTools.fit(true)
      }
      if (visibility.open) visibility.close()
      placementHint.hidden = !enabled || Boolean(headerTools)
      if (resetDialog.open) resetDialog.close()
      renderRows()
      applyHeights()
      root.dispatchEvent(new win.Event('gdw-layout-change'))
      scheduleCues()
      report('')
    }

    function syncMobileOrder() {
      const top = lanes.get('top')
      const left = lanes.get('left')
      if (!top || !left) return
      const previewFirst = surface.clientWidth <= 540 && previewLane === 'left' && state.base === STANDARD &&
        layoutsMatch(state.layout, defaultLayout) && !Object.keys(state.rows).length && cardVisible(cards.get('preview'))
      if (previewFirst === root.classList.contains('gdw-preview-first')) return
      root.classList.toggle('gdw-preview-first', previewFirst)
      const next = previewFirst ? left.nextSibling : left
      const focus = doc.activeElement
      if (typeof root.moveBefore === 'function') root.moveBefore(top, next)
      else root.insertBefore(top, next)
      if (doc.activeElement === doc.body && top.contains(focus)) focus.focus({ preventScroll: true })
    }

    function placeCards() {
      const focus = doc.activeElement
      for (const [id, lane] of lanes) {
        let anchor = null
        const keys = state.layout[id]
        for (let index = keys.length - 1; index >= 0; index--) {
          const key = keys[index]
          const card = cards.get(key)
          if ((key !== 'preview' || canMovePreview) && (card.parentElement !== lane || card.nextElementSibling !== anchor)) {
            if (typeof lane.moveBefore === 'function') lane.moveBefore(card, anchor)
            else lane.insertBefore(card, anchor)
          }
          anchor = card
        }
      }
      syncMobileOrder()
      if (doc.activeElement === doc.body && root.contains(focus) && !focus.disabled) focus.focus({ preventScroll: true })
      root.dispatchEvent(new win.Event('gdw-layout-change'))
      scheduleCues()
    }

    function moveCard(key, to, target = null, side = null) {
      if (target === key || (!canMovePreview && key === 'preview')) return
      const from = cards.get(key).parentElement.dataset.gdwLane
      const layout = { ...state.layout }
      const rows = { ...state.rows }
      function removeFrom(id) {
        return rowsFor(id).map(group => group.filter(other => other !== key)).filter(group => group.length)
      }
      if (from !== to) {
        layout[from] = state.layout[from].filter(other => other !== key)
        if (rows[from]) rows[from] = removeFrom(from)
      }
      const groups = removeFrom(to)
      if (target) {
        const index = groups.findIndex(group => group.includes(target))
        if (index < 0) return
        if (side === 'above' || side === 'below') {
          groups.splice(index + Number(side === 'below'), 0, [key])
        } else {
          const group = groups[index]
          group.splice(group.indexOf(target) + Number(side === 'right'), 0, key)
        }
      } else {
        groups.push([key])
      }
      layout[to] = groups.flat()
      if (target || rows[to]) rows[to] = groups
      if (!layoutsMatch(layout, state.layout) || !sameRows(rows, state.rows)) {
        commit({ ...state, layout, rows }, '配置を変更しました。')
      }
    }

    const picker = element('dialog', '', 'gdw-placement-picker')
    picker.setAttribute('aria-label', '配置位置を選ぶ')
    const pickerTitle = element('h2')
    const targetLabel = element('label', '移動先')
    const targetSelect = element('select')
    targetSelect.setAttribute('aria-label', targetLabel.textContent)
    targetLabel.append(targetSelect)
    const sideLabel = element('label', '置く位置')
    const sideSelect = element('select')
    sideSelect.setAttribute('aria-label', sideLabel.textContent)
    sideSelect.append(option('right', '右に並べる'), option('left', '左に並べる'),
      option('below', '下に行を追加'), option('above', '上に行を追加'))
    sideLabel.append(sideSelect)
    let pickedKey = null
    const confirm = button('ここに配置', () => {
      const target = cards.get(targetSelect.value)
      if (target && cardVisible(target)) moveCard(pickedKey, target.parentElement.dataset.gdwLane, targetSelect.value, sideSelect.value)
      else if (lanes.has(targetSelect.value)) moveCard(pickedKey, targetSelect.value)
      picker.close()
    })
    targetSelect.addEventListener('change', () => { sideSelect.disabled = lanes.has(targetSelect.value) })
    const pickerActions = element('div', '', 'gdw-picker-actions')
    pickerActions.append(button('キャンセル', () => picker.close()), confirm)
    picker.append(pickerTitle, targetLabel, sideLabel, pickerActions)
    bar.append(picker)

    function showPicker(key) {
      if (picker.open || drag || sizeDrag || rowDividers.isActive()) return
      pickedKey = key
      pickerTitle.textContent = '「' + cards.get(key).getAttribute('aria-label') + '」の配置位置'
      targetSelect.replaceChildren()
      for (const id of laneIds) {
        const group = element('optgroup')
        group.label = laneNames[id] ?? id
        for (const other of state.layout[id]) {
          const card = cards.get(other)
          if (key !== other && cardVisible(card)) group.append(option(other, card.getAttribute('aria-label') ?? other))
        }
        group.append(option(id, group.label + 'の末尾'))
        targetSelect.append(group)
      }
      confirm.disabled = !targetSelect.options.length
      sideSelect.value = 'right'
      sideSelect.disabled = lanes.has(targetSelect.value)
      picker.showModal()
      targetSelect.focus()
    }

    function setDrop(x, y) {
      const hit = doc.elementFromPoint(x, y)
      const lane = hit?.closest('[data-gdw-lane]')
      let card = hit?.closest('[data-gdw-card]')
      clearMarker()
      if (!lane || !root.contains(lane) || card === drag.card) return
      // カード間の余白に落としても、いちばん近い辺を狙えるようにする。
      if (!card) {
        let nearest = 13
        for (const key of state.layout[lane.dataset.gdwLane]) {
          const candidate = cards.get(key)
          if (candidate === drag.card || !cardVisible(candidate)) continue
          const r = candidate.getBoundingClientRect()
          const distance = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom))
          if (distance < nearest) { nearest = distance; card = candidate }
        }
      }
      let side = null
      if (card) {
        const rect = card.getBoundingClientRect()
        const dx = (x - rect.left) / rect.width - 0.5
        const dy = (y - rect.top) / rect.height - 0.5
        if (Math.abs(dx) > Math.abs(dy)) side = dx < 0 ? 'left' : 'right'
        else side = dy < 0 ? 'above' : 'below'
        card.dataset.gdwDropSide = side
      }
      lane.classList.add('gdw-drop-lane')
      marker = { lane, card, side }
    }

    function clearMarker() {
      if (!marker) return
      marker.lane.classList.remove('gdw-drop-lane')
      if (marker.card) delete marker.card.dataset.gdwDropSide
      marker = null
    }

    function scrollWhileDragging() {
      scrollFrame = 0
      if (!drag?.moved) return
      const lane = doc.elementFromPoint(drag.x, drag.y)?.closest('[data-gdw-lane]')
      let scrolled = false
      if (lane && root.contains(lane)) {
        const rect = lane.getBoundingClientRect()
        const edge = Math.min(32, rect.height / 4)
        const previous = lane.scrollTop
        if (drag.y < rect.top + edge) lane.scrollTop -= 14
        else if (drag.y > rect.bottom - edge) lane.scrollTop += 14
        const previousX = lane.scrollLeft
        if (drag.x < rect.left + 30) lane.scrollLeft -= 14
        else if (drag.x > rect.right - 30) lane.scrollLeft += 14
        scrolled = lane.scrollTop !== previous || lane.scrollLeft !== previousX
      }
      if (!scrolled && scrollArea.scrollWidth > scrollArea.clientWidth) {
        const frame = scrollArea.getBoundingClientRect()
        if (drag.y >= frame.top && drag.y <= frame.bottom) {
          const previous = scrollArea.scrollLeft
          if (drag.x < frame.left + 32) scrollArea.scrollLeft -= 14
          else if (drag.x > frame.right - 32) scrollArea.scrollLeft += 14
          scrolled = scrollArea.scrollLeft !== previous
        }
      }
      if (!scrolled) {
        const amount = drag.y < 48 ? -14 : drag.y > win.innerHeight - 48 ? 14 : 0
        if (!amount) return
        const previous = win.scrollY
        win.scrollBy(0, amount)
        if (win.scrollY === previous) return
      }
      setDrop(drag.x, drag.y)
      scrollFrame = win.requestAnimationFrame(scrollWhileDragging)
    }

    function stopDrag() {
      if (!drag) return
      const { card, handle, pointer } = drag
      drag = null
      if (scrollFrame) win.cancelAnimationFrame(scrollFrame)
      scrollFrame = 0
      card.classList.remove('gdw-dragging')
      root.classList.remove('gdw-board-dragging')
      clearMarker()
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer)
    }

    function attachDrag(handle, card, key) {
      let suppressClick = false
      const options = { signal: keyboard.signal }
      handle.addEventListener('click', event => {
        if (suppressClick && event.detail !== 0) {
          event.preventDefault()
          event.stopPropagation()
        }
        suppressClick = false
      }, { ...options, capture: true })
      handle.addEventListener('keydown', event => {
        if (event.target === handle && event.altKey && event.key === 'Enter') {
          event.preventDefault()
          showPicker(key)
        }
      }, options)
      handle.addEventListener('pointerdown', event => {
        if (drag || sizeDrag || rowDividers.isActive() || !event.isPrimary || event.button !== 0) return
        if (event.target.closest('button, a, input, select, textarea, [contenteditable="true"]')) return
        if (event.pointerType === 'touch' && !event.target.closest('.gdw-card-grip')) return
        suppressClick = false
        handle.setPointerCapture(event.pointerId)
        drag = { card, handle, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
      }, options)
      handle.addEventListener('pointermove', event => {
        if (drag?.pointer !== event.pointerId) return
        const { clientX: x, clientY: y } = event
        if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < 5) return
        drag.moved = true
        suppressClick = true
        drag.x = x
        drag.y = y
        card.classList.add('gdw-dragging')
        root.classList.add('gdw-board-dragging')
        setDrop(x, y)
        if (!scrollFrame) scrollFrame = win.requestAnimationFrame(scrollWhileDragging)
      }, options)
      handle.addEventListener('pointerup', event => {
        if (drag?.pointer !== event.pointerId) return
        if (drag.moved) setDrop(event.clientX, event.clientY)
        const drop = marker
        stopDrag()
        if (!drop) return
        const id = drop.lane.dataset.gdwLane
        const target = drop.card?.dataset.gdwCard
        moveCard(key, id, target, drop.side)
      }, options)
      handle.addEventListener('lostpointercapture', event => {
        if (drag?.pointer === event.pointerId) stopDrag()
      }, options)
      handle.addEventListener('pointercancel', event => {
        if (drag?.pointer === event.pointerId) stopDrag()
      }, options)
    }

    function edgeGeometry(id, tracks = gridTracks()) {
      const { lane, boundary } = boundaries.get(id)
      const rect = lane.getBoundingClientRect()
      const slot = boundary.getBoundingClientRect()
      const names = tracks.length === 3 ? ['left', 'center', 'right'] : tracks.length === 2 ? ['center', 'right'] : []
      const min = tracks.length === 3 ? trackMinimums.wide : trackMinimums.pair
      const total = tracks.reduce((sum, width) => sum + width, 0)
      const gap = parseFloat(win.getComputedStyle(root).columnGap) || 0
      const minimum = Math.min(min.px, (total + (tracks.length - 1) * gap) * min.percent / 100)
      return { id, rect, slot, tracks, total, minimum, index: names.indexOf(id) }
    }

    function neighborSpace(geometry, edge) {
      if (geometry.index < 0) return 0
      const adjacent = geometry.index + (edge === 'left' ? -1 : 1)
      return Math.max(0, (geometry.tracks[adjacent] ?? 0) - geometry.minimum)
    }

    // 段内の境界はカードを動かさずに重ねる。プレビューは state に保存しない。
    function setupRowDividers() {
      const controller = new win.AbortController()
      const layer = element('div', '', 'gdw-row-dividers')
      const dividers = new Map()
      let active = null
      let destroyed = false
      root.append(layer)

      function sameGroup(a, b) {
        return a.length === b.length && a.every((key, index) => key === b[index])
      }

      function draftWidths(current) {
        if (current.legacy) return { ...state.widths, [current.id]: current.value }
        const shares = [...current.shares]
        const total = shares[current.first] + shares[current.second]
        shares[current.first] = total * current.value / 100
        shares[current.second] = total - shares[current.first]
        const rows = { ...state.widths.rows }
        rows[current.id] = (rows[current.id] ?? []).filter(row => !sameGroup(row.cards, current.group))
        rows[current.id].push({ cards: [...current.group], shares, min: current.baseline })
        return { ...state.widths, rows }
      }

      function paintDraft() {
        const widths = draftWidths(active)
        renderRows(widths)
        paintWidths(widths)
        refresh()
      }

      function finish(save) {
        if (!active) return
        const current = active
        active = null
        current.handle.classList.remove('gdw-row-divider-active')
        if (current.pointer != null && current.handle.hasPointerCapture(current.pointer)) {
          current.handle.releasePointerCapture(current.pointer)
        }
        if (save && Math.abs(current.value - current.initial) > 1e-9) {
          const next = { ...state, widths: readWidths(draftWidths(current)) }
          commit(next, null, false)
        } else applyWidths()
        refresh()
      }

      function start(entry, pointer = null, x = 0) {
        if (destroyed || entry.handle.hidden || drag || sizeDrag) return false
        if (active?.handle !== entry.handle) finish(true)
        if (!active) {
          active = { id: entry.id, handle: entry.handle, pointer, x, span: entry.span,
            initial: entry.value, value: entry.value, legacy: entry.legacy, group: [...entry.group],
            shares: [...entry.shares], first: entry.first, second: entry.second,
            min: entry.min, max: entry.max, baseline: entry.baseline }
          entry.handle.classList.add('gdw-row-divider-active')
        }
        return true
      }

      function previewPointer(event) {
        if (active?.pointer !== event.pointerId) return
        const delta = event.clientX - active.x
        active.value = Math.abs(delta) < 1 ? active.initial : Math.max(active.min, Math.min(active.max, Math.round(active.initial +
          delta * 100 / active.span)))
        paintDraft()
      }

      function makeEntry(id, key) {
        const handle = element('div', '', 'gdw-row-divider')
        handle.dataset.gdwRowDivider = id
        handle.setAttribute('role', 'separator')
        handle.setAttribute('aria-orientation', 'vertical')
        handle.setAttribute('aria-valuemin', '20')
        handle.setAttribute('aria-valuemax', '80')
        handle.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Escape Home')
        handle.tabIndex = 0
        const entry = { id, key, handle, span: 1 }
        const options = { signal: controller.signal }
        handle.addEventListener('pointerdown', event => {
          if (!event.isPrimary || event.button !== 0 || active?.pointer != null) return
          if (!start(entry, event.pointerId, event.clientX)) return
          active.pointer = event.pointerId
          active.x = event.clientX
          active.initial = active.value
          active.span = entry.span
          event.preventDefault()
          event.stopPropagation()
          handle.focus({ preventScroll: true })
          handle.setPointerCapture(event.pointerId)
        }, options)
        handle.addEventListener('pointermove', previewPointer, options)
        handle.addEventListener('pointerup', event => {
          if (active?.pointer !== event.pointerId) return
          previewPointer(event)
          finish(true)
        }, options)
        for (const type of ['lostpointercapture', 'pointercancel']) {
          handle.addEventListener(type, event => {
            if (active?.pointer === event.pointerId) finish(false)
          }, options)
        }
        handle.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'Escape'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') { finish(false); return }
          if (active?.pointer != null || !start(entry)) return
          const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1)
          active.value = event.key === 'Home' ? Math.max(active.min, Math.min(active.max, 50)) :
            Math.max(active.min, Math.min(active.max, active.value + delta))
          finish(true)
        }, options)
        handle.addEventListener('blur', () => {
          if (active?.handle === handle && active.pointer == null) finish(true)
        }, options)
        handle.addEventListener('dblclick', event => {
          event.preventDefault()
          if (!start(entry)) return
          active.value = Math.max(active.min, Math.min(active.max, 50))
          finish(true)
        }, options)
        layer.append(handle)
        dividers.set(key, entry)
        return entry
      }

      function refresh() {
        if (destroyed) return
        const boardRect = root.getBoundingClientRect()
        const seen = new Set()
        const widths = active ? draftWidths(active) : state.widths
        for (const id of laneIds) {
          const lane = lanes.get(id)
          if (!lane || lane.hidden) continue
          if (id !== 'top' && id !== 'bottom' && !state.rows[id]) continue
          const laneRect = lane.getBoundingClientRect()
          const clipLeft = laneRect.left + lane.clientLeft
          const clipTop = laneRect.top + lane.clientTop
          const clipRight = clipLeft + lane.clientWidth
          const clipBottom = clipTop + lane.clientHeight
          // 実際の行を使う。標準配置で hidden のカードが詰まった場合も扱える。
          const rows = []
          for (const card of lane.children) {
            if (!card.hasAttribute('data-gdw-card') || card.hidden || !card.getClientRects().length) continue
            const rect = card.getBoundingClientRect()
            if (!rect.width || !rect.height) continue
            let row = rows.find(group => Math.abs(group[0].rect.top - rect.top) < 2)
            if (!row) rows.push(row = [])
            row.push({ card, rect })
          }
          rows.forEach((row, index) => {
            if (row.length < 2) return
            const visibleKeys = row.map(item => item.card.dataset.gdwCard)
            const group = state.rows[id]?.find(keys => visibleKeys.every(key => keys.includes(key))) ?? visibleKeys
            const saved = widths.rows?.[id]?.find(item => sameGroup(item.cards, group))
            const firstPair = (id === 'top' || id === 'bottom') ? (widths[id] ?? 50) / 100 : 0.5
            const shares = saved ? [...saved.shares] : group.map(key => {
              const visibleIndex = visibleKeys.indexOf(key)
              if (visibleIndex < 0) return 1 / group.length
              let share = 1 / group.length
              if (visibleIndex < 2) share *= 2 * (visibleIndex === 0 ? firstPair : 1 - firstPair)
              return share
            })
            for (let boundaryIndex = 0; boundaryIndex < row.length - 1; boundaryIndex++) {
              const first = row[boundaryIndex]
              const second = row[boundaryIndex + 1]
              const gap = second.rect.left - first.rect.right
              // 縦積みや、重なっている非対応の配置では境界を出さない。
              if (gap < -1 || second.rect.left <= first.rect.left || gap > 32) continue
              const key = JSON.stringify([id, group, first.card.dataset.gdwCard, second.card.dataset.gdwCard])
              const entry = dividers.get(key) ?? makeEntry(id, key)
              entry.group = group
              entry.shares = shares
              entry.first = group.indexOf(first.card.dataset.gdwCard)
              entry.second = group.indexOf(second.card.dataset.gdwCard)
              entry.legacy = !state.rows[id] && (id === 'top' || id === 'bottom') && group.length === 2
              entry.baseline = saved?.min ?? Math.max(...visibleKeys.map((key, visibleIndex) => {
                let share = 1 / visibleKeys.length
                if (visibleIndex < 2) share *= 2 * (visibleIndex === 0 ? firstPair : 1 - firstPair)
                return Math.ceil(156 / share)
              }))
              entry.value = entry.legacy ? widths[id] ?? 50 : 100 * shares[entry.first] /
                (shares[entry.first] + shares[entry.second])
              seen.add(key)
              const handle = entry.handle
              const x = (first.rect.right + second.rect.left) / 2
              const top = Math.max(first.rect.top, second.rect.top, clipTop)
              const bottom = Math.min(Math.max(...row.map(item => item.rect.bottom)), clipBottom)
              const half = win.matchMedia('(pointer: coarse)').matches ? 12 : 7
              const left = Math.max(clipLeft, x - half)
              const right = Math.min(clipRight, x + half)
              handle.hidden = bottom - top < 12 || right <= left || x < clipLeft || x > clipRight
              // 両端で引かれた半分の隙間を戻し、選んだ2枚の合計幅を保つ。
              entry.span = Math.max(1, second.rect.right - first.rect.left +
                (boundaryIndex ? gap / 2 : 0) + (boundaryIndex + 2 < row.length ? gap / 2 : 0))
              // 領域を自動拡幅して他のカードを押し広げず、2枚の可動域で止める。
              const minimum = state.rows[id] ? Math.ceil(121 * 100 / entry.span) : 20
              entry.min = Math.min(entry.value, Math.max(20, minimum))
              entry.max = Math.max(entry.value, Math.min(80, 100 - minimum))
              handle.style.left = (left - boardRect.left - root.clientLeft + root.scrollLeft) + 'px'
              handle.style.top = (top - boardRect.top - root.clientTop + root.scrollTop) + 'px'
              handle.style.width = Math.max(0, right - left) + 'px'
              handle.style.height = Math.max(0, bottom - top) + 'px'
              handle.style.setProperty('--gdw-row-grip-x', (x - left) + 'px')
              const value = Math.round(entry.value)
              const title = (laneNames[id] ?? id) + '・' + (index + 1) + '行目の' +
                (boundaryIndex + 1) + '枚目と' + (boundaryIndex + 2) + '枚目の幅'
              handle.title = title + '。ドラッグまたは左右キーで調整。ドラッグ中はEscで取消。Homeまたはダブルクリックで均等'
              handle.setAttribute('aria-label', handle.title)
              handle.setAttribute('aria-valuenow', value)
              handle.setAttribute('aria-valuemin', entry.min)
              handle.setAttribute('aria-valuemax', entry.max)
              handle.setAttribute('aria-valuetext', '左側 ' + value + '%、右側 ' + (100 - value) + '%')
              handle.dataset.gdwRowRatio = value
              handle.dataset.gdwRowBoundary = boundaryIndex
              }
            })
          }
          for (const [key, entry] of dividers) {
            if (seen.has(key)) continue
            if (active?.handle === entry.handle) finish(false)
            entry.handle.remove()
            dividers.delete(key)
          }
        }

        // ドラッグ中は、フォーカスの所在にかかわらず Esc で取り消せる。
        doc.addEventListener('keydown', event => {
          if (event.key !== 'Escape' || !active) return
          event.preventDefault()
          event.stopPropagation()
          finish(false)
        }, { signal: controller.signal })
        return {
          refresh,
          cancel() { finish(false) },
          isActive() { return Boolean(active) },
          destroy() {
            if (destroyed) return
            destroyed = true
            finish(false)
            controller.abort()
            layer.remove()
            dividers.clear()
          },
        }
      }

      function positionWidthEdges() {
        const tracks = gridTracks()
        const board = root.getBoundingClientRect()
        for (const [id, { lane, boundary, handles, reset, readout }] of boundaries) {
          boundary.hidden = !lane.getClientRects().length || (!editing && !state.layout[id].some(key => cardVisible(cards.get(key))))
          if (boundary.hidden) continue
          const geometry = edgeGeometry(id, tracks)
          const { rect, slot } = geometry
          const top = rect.top - slot.top
          const left = rect.left - slot.left
          for (const edge of ['left', 'right']) {
            const handle = handles[edge]
            const width = handle.offsetWidth
            const x = edge === 'left' ? left : rect.right - slot.left
            // 通常時は盤面の余白も当たり判定に使い、カード内の操作との重なりを減らす。
            const min = editing ? 0 : board.left - slot.left
            const max = editing ? slot.width : board.right - slot.left
            const start = Math.max(min, Math.min(max - width, x - width / 2))
            handle.style.left = start + 'px'
            handle.style.setProperty('--gdw-grip-x', Math.max(2, Math.min(width - 2, x - start)) + 'px')
            handle.style.top = top + 'px'
            handle.style.height = rect.height + 'px'
            const available = edge === 'left' ? rect.right - slot.left : slot.right - rect.left
            handle.setAttribute('aria-valuemin', Math.min(MIN_LANE_WIDTH, Math.round(rect.width)))
            handle.setAttribute('aria-valuemax', Math.round(available + neighborSpace(geometry, edge)))
            handle.setAttribute('aria-valuenow', Math.round(rect.width))
            handle.setAttribute('aria-valuetext', Math.round(rect.width) + ' px')
          }
          const bottom = handles.bottom
          bottom.style.left = (left + 12) + 'px'
          const bottomY = top + rect.height
          const handleTop = editing ? bottomY - 4 : Math.min(bottomY - bottom.offsetHeight / 2, board.bottom - slot.top - bottom.offsetHeight)
          bottom.style.top = handleTop + 'px'
          bottom.style.setProperty('--gdw-height-grip-y', Math.min(bottom.offsetHeight - 2, bottomY - handleTop) + 'px')
          bottom.style.width = Math.max(0, rect.width - 24) + 'px'
          bottom.setAttribute('aria-valuemin', 80)
          bottom.setAttribute('aria-valuemax', 4000)
          const cap = sizeDrag?.id === id ? sizeDrag.height ?? state.heights[id] : state.heights[id]
          bottom.setAttribute('aria-valuenow', cap ?? Math.max(80, Math.min(4000, Math.round(rect.height))))
          bottom.setAttribute('aria-valuetext', cap == null ? '高さの上限なし' : '高さの上限 ' + cap + ' px')
          const mode = sizeMode(id, tracks.length)
          reset.hidden = !editing || (!state.widths.limits[id] && state.heights[id] == null && (!mode || state.widths[mode] == null) && !state.widths.rows?.[id]?.length)
          reset.style.right = (slot.right - rect.right + handles.right.offsetWidth + 2) + 'px'
          reset.style.top = (top + 2) + 'px'
          readout.hidden = sizeDrag?.id !== id || (!sizeDrag.draft && sizeDrag.height == null)
          if (!readout.hidden) {
            const height = sizeDrag.edge === 'bottom'
            readout.textContent = (height ? '上限 ' + sizeDrag.height : Math.round(rect.width)) + ' px'
            const x = sizeDrag.edge === 'left' ? left + 8 : left + rect.width - readout.offsetWidth - 8
            readout.style.left = x + 'px'
            readout.style.top = Math.max(top + 2, Math.min(top + rect.height - 25, sizeDrag.clientY - slot.top - 28)) + 'px'
          }
        }
      }

      // 反対の辺を固定する。列内の余白を使い切ったら、つかんだ側の隣列から幅を取る。
      function widthsAt(edge, geometry, delta) {
        const { rect, slot, tracks, total, index } = geometry
        const leftEdge = edge === 'left'
        const growth = leftEdge ? -delta : delta
        const room = Math.max(0, leftEdge ? rect.left - slot.left : slot.right - rect.right)
        const borrowed = Math.min(neighborSpace(geometry, edge), Math.max(0, growth - room))
        const widths = { ...state.widths }
        if (borrowed > 0) {
          const sizes = [...tracks]
          sizes[index] += borrowed
          sizes[index + (leftEdge ? -1 : 1)] -= borrowed
          const first = 100 * sizes[0] / total
          if (sizes.length === 3) widths.wide = [first, 100 * sizes[1] / (sizes[1] + sizes[2])]
          else widths.pair = first
        }
        const max = Math.max(MIN_LANE_WIDTH, Math.round(rect.width + Math.min(growth, room + borrowed)))
        const slotLeft = slot.left - (leftEdge ? borrowed : 0)
        const offset = (leftEdge ? rect.right - max : rect.left) - slotLeft
        const slack = slot.width + borrowed - max
        const anchor = slack > 0.5 ? Math.max(0, Math.min(1, offset / slack)) : Number(leftEdge)
        widths.limits = { ...widths.limits, [geometry.id]: { max, anchor } }
        return widths
      }

      function heightAt(start, delta) {
        return Math.max(80, Math.min(4000, Math.round(start + delta)))
      }

      function finishSizeDrag(save) {
        if (!sizeDrag) return
        const { id, draft, height, pointer, handle } = sizeDrag
        sizeDrag = null
        const { lane, readout } = boundaries.get(id)
        lane.classList.remove('gdw-sizing-target')
        readout.hidden = true
        if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer)
        if (save && height != null) commit({ ...state, heights: { ...state.heights, [id]: height } }, null, false)
        else if (save && draft) commit({ ...state, widths: draft }, null, false)
        else { paintWidths(); applyHeights() }
      }

      function previewSize(event) {
        const current = sizeDrag
        if (event.pointerId !== current?.pointer) return
        current.clientY = event.clientY
        if (current.edge === 'bottom') {
          const delta = event.clientY - current.y
          current.height = delta === 0 ? null : heightAt(current.geometry.rect.height, delta)
          applyHeights()
        } else {
          const delta = event.clientX - current.x
          current.draft = Math.abs(delta) < 1 ? null : widthsAt(current.edge, current.geometry, delta)
          paintWidths()
        }
      }

      function attachSizeEdge(id, handle, edge) {
        const height = edge === 'bottom'
        const opts = { signal: keyboard.signal }
        handle.addEventListener('pointerdown', event => {
          if (sizeDrag || drag || rowDividers.isActive() || !event.isPrimary || event.button !== 0) return
          event.preventDefault()
          handle.focus({ preventScroll: true })
          sizeDrag = { id, edge, handle, pointer: event.pointerId, x: event.clientX, y: event.clientY,
            clientY: event.clientY, draft: null, height: null, geometry: edgeGeometry(id) }
          boundaries.get(id).lane.classList.add('gdw-sizing-target')
          handle.setPointerCapture(event.pointerId)
        }, opts)
        handle.addEventListener('pointermove', previewSize, opts)
        handle.addEventListener('pointerup', event => {
          if (event.pointerId !== sizeDrag?.pointer) return
          previewSize(event)
          finishSizeDrag(true)
        }, opts)
        for (const type of ['lostpointercapture', 'pointercancel']) handle.addEventListener(type, event => {
          if (event.pointerId === sizeDrag?.pointer) finishSizeDrag(false)
        }, opts)
        handle.addEventListener('keydown', event => {
          if (sizeDrag || drag || rowDividers.isActive()) return
          if (event.key === 'Home') {
            event.preventDefault()
            resetSize(id, height ? 'height' : 'limit')
            return
          }
          const keys = height ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
          if (!keys.includes(event.key)) return
          event.preventDefault()
          const delta = (event.key === keys[0] ? -1 : 1) * (event.shiftKey ? 10 : 1)
          const geometry = edgeGeometry(id)
          if (height) {
            const max = heightAt(state.heights[id] ?? geometry.rect.height, delta)
            commit({ ...state, heights: { ...state.heights, [id]: max } }, null, false)
          } else commit({ ...state, widths: widthsAt(edge, geometry, delta) }, null, false)
        }, opts)
        handle.addEventListener('dblclick', event => {
          event.preventDefault()
          openSizeReset(id)
        }, opts)
      }

      // 合図はスクロール内容の外に置き、内容が下に残る場合だけ領域の下端に重ねる。
      function scheduleCues(geometryChanged = true) {
        if (geometryChanged !== false) geometryDirty = true
        if (!cueFrame) cueFrame = win.requestAnimationFrame(updateCues)
      }

      function updateCues() {
        cueFrame = 0
        if (geometryDirty) {
          geometryDirty = false
          positionWidthEdges()
          rowDividers.refresh()
        }
        const boardRect = root.getBoundingClientRect()
        for (const [id, lane] of lanes) {
          const cue = cues.get(id)
          if (!cue) continue
          const rect = lane.getBoundingClientRect()
          const more = lane.classList.contains('gdw-capped') && rect.height > 0 && lane.clientHeight > 0 &&
            lane.scrollHeight - lane.clientHeight - lane.scrollTop > 2
          cue.hidden = !more
          lane.dataset.gdwScrollMore = String(more)
          if (!more) continue
          cue.style.left = (rect.left - boardRect.left + root.scrollLeft + rect.width / 2) + 'px'
          cue.style.top = (rect.bottom - boardRect.top + root.scrollTop - 7) + 'px'
        }
      }

      for (const [id, lane] of lanes) {
        lane.dataset.gdwLaneLabel = laneNames[id] ?? id
        const cue = element('span', '↓ 下に続く', 'gdw-scroll-cue')
        cue.dataset.gdwScrollCue = id
        cue.hidden = true
        cue.setAttribute('aria-hidden', 'true')
        root.append(cue)
        cues.set(id, cue)
        lane.addEventListener('scroll', scheduleCues, { passive: true, signal: keyboard.signal })
      }
      for (const [id, card] of cards) {
        let title = card.querySelector('.gdw-card-heading') ?? card.querySelector('h2, summary')
        if (!title) {
          title = element('h2', card.getAttribute('aria-label') ?? id, 'gdw-card-heading')
          card.prepend(title)
        }
        if (id === 'preview' && !canMovePreview) {
          title.title = 'このブラウザではプレビューの位置は固定です。'
          continue
        }
        const handle = title.closest('summary') ?? title
        const grip = element('span', '', 'gdw-card-grip')
        grip.setAttribute('aria-hidden', 'true')
        title.prepend(grip)
        handle.classList.add('gdw-drag-handle')
        if (handle === title) handle.tabIndex = 0
        handle.title = '見出しをドラッグして移動。Alt＋Enterで配置先を選択'
        handle.setAttribute('aria-keyshortcuts', 'Alt+Enter')
        attachDrag(handle, card, id)
      }

      doc.addEventListener('keydown', event => {
        if (event.key === 'Escape' && drag) stopDrag()
        if (event.key === 'Escape' && sizeDrag) { event.preventDefault(); finishSizeDrag(false) }
      }, { signal: keyboard.signal })
      const resize = new win.ResizeObserver(entries => {
        if (entries.some(entry => entry.target === scrollArea)) syncAvailableWidth()
        if (entries.some(entry => entry.target === surface)) syncMobileOrder()
        scheduleCues()
      })
      resize.observe(scrollArea)
      resize.observe(surface)
      resize.observe(root)
      for (const lane of lanes.values()) resize.observe(lane)
      for (const card of cards.values()) resize.observe(card)
      const mutation = new win.MutationObserver(records => {
        const cardVisibilityChanged = records.some(change => change.attributeName === 'hidden' && change.target.hasAttribute('data-gdw-card'))
        if (cardVisibilityChanged) renderRows()
        // 時計やログの文言が変わっても位置とサイズが同じなら、境界の再配置は不要。
        // カードと領域の実サイズの変化は ResizeObserver が拾う。
        scheduleCues(cardVisibilityChanged)
      })
      for (const lane of lanes.values()) mutation.observe(lane, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open'] })
      root.addEventListener('toggle', scheduleCues, { capture: true, signal: keyboard.signal })
      win.addEventListener('resize', () => { finishSizeDrag(false); rowDividers.cancel(); scheduleCues() }, { signal: keyboard.signal })
      syncVisibility(state.hiddenCards)
      applyWidths()
      applyHeights()
      refreshMenu()
      placeCards()
      return {
        captureLayout() {
          return Object.fromEntries(laneIds.map(id => [id, [...state.layout[id]]]))
        },
        captureRows() { return readRows(state.rows, state.layout) },
        captureWidths() { return readWidths(state.widths) },
        captureHeights() { return readHeights(state.heights) },
        captureHiddenCards() { return [...state.hiddenCards] },
        applyLayout(layout, widths, heights, rows, hiddenCards) {
          const normalized = normalizeLayout(layout)
          const next = { ...state, layout: normalized, rows: readRows(rows, normalized), widths: readWidths(widths), heights: readHeights(heights), hiddenCards: readHidden(hiddenCards) }
          rememberLayout(next)
          commit(next, '')
        },
        destroy() {
          win.clearTimeout(messageTimer)
          headerTools?.destroy()
          if (visibility.open) visibility.close()
          if (headerAnchor) headerAnchor.replaceWith(header)
          finishSizeDrag(false)
          rowDividers.destroy()
          if (resetDialog.open) resetDialog.close()
          for (const { boundary } of boundaries.values()) boundary.remove()
          resize.disconnect()
          mutation.disconnect()
          if (cueFrame) win.cancelAnimationFrame(cueFrame)
          for (const cue of cues.values()) cue.remove()
          stopDrag()
          if (picker.open) picker.close()
          keyboard.abort()
          if (scrollArea.parentNode) {
            if (root.isConnected && typeof scrollArea.parentNode.moveBefore === 'function') {
              scrollArea.parentNode.moveBefore(root, scrollArea)
              scrollArea.remove()
            } else scrollArea.replaceWith(root)
          }
        },
      }
    }

    scope.GameDebugBoard = { mount }
  })(globalThis)
