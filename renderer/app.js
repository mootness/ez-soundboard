/* ═══════════════════════════════════════════════
   EZ Soundboard — app.js
   Electron renderer process (Vanilla JS)
═══════════════════════════════════════════════ */

const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm']
const COLORS = ['default', 'red', 'orange', 'green', 'blue', 'purple', 'pink']

const TILE_SIZES = {
  small:  { cols: 5, rows: 5, count: 25 },
  medium: { cols: 5, rows: 4, count: 20 },
  large:  { cols: 4, rows: 3, count: 12 }
}

function getTilesPerPage() {
  return TILE_SIZES[currentTileSize]?.count ?? 20
}

// ── State ─────────────────────────────────────
let config = { pages: [], settings: { masterVolume: 1.0 } }
let currentPageIndex = 0
let activeAudio = new Map()   // tileId → HTMLAudioElement (primary output)
let activeMonitor = new Map() // tileId → HTMLAudioElement (monitor output)
let masterVolume = 1.0
let currentTileSize = 'medium'
let selectedSinkId = ''
let monitorSinkId = ''
let searchQuery = ''

// Context menu state
let ctxTileId = null
let ctxPageIndex = null

// Drag state
let dragSrcIndex = null

// ── DOM refs ──────────────────────────────────
const pageTabs     = document.getElementById('pageTabs')
const tileGrid     = document.getElementById('tileGrid')
const stopAllBtn   = document.getElementById('stopAllBtn')
const importFolderBtn = document.getElementById('importFolderBtn')
const masterVolumeSlider = document.getElementById('masterVolume')
const masterVolumeValue  = document.getElementById('masterVolumeValue')
const infoText     = document.getElementById('infoText')

const contextMenu  = document.getElementById('contextMenu')
const ctxTileName  = document.getElementById('ctxTileName')
const ctxRename    = document.getElementById('ctxRename')
const ctxSetShortcut = document.getElementById('ctxSetShortcut')
const ctxChangeFile= document.getElementById('ctxChangeFile')
const ctxVolume    = document.getElementById('ctxVolume')
const ctxVolumeValue = document.getElementById('ctxVolumeValue')
const colorSwatches  = document.getElementById('colorSwatches')
const ctxShowInFolder= document.getElementById('ctxShowInFolder')
const ctxDelete    = document.getElementById('ctxDelete')

const shortcutModal      = document.getElementById('shortcutModal')
const shortcutModalFor   = document.getElementById('shortcutModalFor')
const shortcutCaptureBox = document.getElementById('shortcutCaptureBox')
const shortcutCaptureLabel = document.getElementById('shortcutCaptureLabel')
const shortcutClearBtn   = document.getElementById('shortcutClearBtn')
const shortcutCancelBtn  = document.getElementById('shortcutCancelBtn')

const searchInput    = document.getElementById('searchInput')
const searchClearBtn = document.getElementById('searchClearBtn')
const audioOutputSelect  = document.getElementById('audioOutputSelect')
const audioMonitorSelect = document.getElementById('audioMonitorSelect')

const helpBtn   = document.getElementById('helpBtn')
const helpModal = document.getElementById('helpModal')
const helpCloseBtn = document.getElementById('helpCloseBtn')

const renameModal  = document.getElementById('renameModal')
const renameInput  = document.getElementById('renameInput')
const renameCancelBtn  = document.getElementById('renameCancelBtn')
const renameConfirmBtn = document.getElementById('renameConfirmBtn')

// ── Utilities ─────────────────────────────────
function generateId() {
  return Math.random().toString(36).slice(2, 10)
}

function setInfo(msg) {
  infoText.textContent = msg
}

function getPage() {
  return config.pages[currentPageIndex]
}

function getTileById(tileId, pageIndex = currentPageIndex) {
  const page = config.pages[pageIndex]
  if (!page) return null
  return page.tiles.find(t => t.id === tileId) || null
}

function getTileBySlot(slot, pageIndex = currentPageIndex) {
  const page = config.pages[pageIndex]
  if (!page) return null
  return page.tiles.find(t => t.slot === slot) || null
}

// ── Config ────────────────────────────────────
async function loadConfig() {
  try {
    const loaded = await window.api.readConfig()
    if (loaded && loaded.pages && loaded.pages.length > 0) {
      config = loaded
    } else {
      config = {
        pages: [{ id: generateId(), name: 'Page 1', tiles: [] }],
        settings: { masterVolume: 1.0 }
      }
    }
    masterVolume = config.settings?.masterVolume ?? 1.0
    masterVolumeSlider.value = Math.round(masterVolume * 100)
    masterVolumeValue.textContent = masterVolumeSlider.value + '%'
    currentTileSize = config.settings?.tileSize ?? 'medium'
    tileGrid.dataset.size = currentTileSize
    selectedSinkId = config.settings?.audioOutputDeviceId ?? ''
    monitorSinkId  = config.settings?.monitorOutputDeviceId ?? ''
  } catch (e) {
    console.error('Failed to load config:', e)
  }
}

async function saveConfig() {
  config.settings.masterVolume = masterVolume
  await window.api.writeConfig(config)
}

// ── Render: Pages ─────────────────────────────
function renderPages() {
  pageTabs.innerHTML = ''

  config.pages.forEach((page, idx) => {
    const tab = document.createElement('div')
    tab.className = 'page-tab' + (idx === currentPageIndex ? ' active' : '')
    tab.dataset.idx = idx

    const nameEl = document.createElement('span')
    nameEl.className = 'tab-name'
    nameEl.textContent = page.name
    nameEl.title = 'Double-click to rename'

    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      showPageRenameModal(page)
    })

    tab.appendChild(nameEl)

    // Close button (don't show if only one page)
    if (config.pages.length > 1) {
      const closeBtn = document.createElement('button')
      closeBtn.className = 'tab-close'
      closeBtn.textContent = '×'
      closeBtn.title = 'Remove page'
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        deletePage(idx)
      })
      tab.appendChild(closeBtn)
    }

    tab.addEventListener('click', () => {
      currentPageIndex = idx
      renderPages()
      renderTiles()
    })

    pageTabs.appendChild(tab)
  })

  // Add page button
  const addBtn = document.createElement('button')
  addBtn.className = 'page-tab-add'
  addBtn.textContent = '+ Add Page'
  addBtn.addEventListener('click', addPage)
  pageTabs.appendChild(addBtn)
}

function addPage() {
  const n = config.pages.length + 1
  config.pages.push({ id: generateId(), name: `Page ${n}`, tiles: [] })
  currentPageIndex = config.pages.length - 1
  saveConfig()
  renderPages()
  renderTiles()
}

function deletePage(idx) {
  config.pages.splice(idx, 1)
  if (currentPageIndex >= config.pages.length) {
    currentPageIndex = config.pages.length - 1
  }
  saveConfig()
  renderPages()
  renderTiles()
}

// ── Render: Tiles ─────────────────────────────
function renderTiles() {
  tileGrid.innerHTML = ''
  if (searchQuery) {
    renderSearchResults()
    return
  }

  const page = getPage()
  if (!page) return

  for (let slot = 0; slot < getTilesPerPage(); slot++) {
    const tile = page.tiles.find(t => t.slot === slot)
    const el = tile ? buildTileEl(tile, slot) : buildEmptyTileEl(slot)
    tileGrid.appendChild(el)
  }
}

function renderSearchResults() {
  const matches = findSearchMatches(searchQuery)

  if (matches.length === 0) {
    const msg = document.createElement('div')
    msg.className = 'search-empty'
    msg.textContent = `No results for "${searchInput.value.trim()}"`
    tileGrid.appendChild(msg)
    setInfo('No matches found')
    return
  }

  matches.forEach(({ tile, pageIdx }) => {
    const el = buildTileEl(tile, tile.slot, pageIdx)
    const pageBadge = document.createElement('span')
    pageBadge.className = 'search-page-badge'
    pageBadge.textContent = config.pages[pageIdx]?.name ?? `Page ${pageIdx + 1}`
    el.appendChild(pageBadge)
    tileGrid.appendChild(el)
  })

  setInfo(`${matches.length} result${matches.length !== 1 ? 's' : ''} — click to play`)
}

function buildTileEl(tile, slot, pageIdx = currentPageIndex) {
  const el = document.createElement('div')
  el.className = 'tile'
  el.dataset.tileId = tile.id
  el.dataset.slot = slot
  el.dataset.color = tile.color || 'default'
  if (!searchQuery) el.draggable = true

  if (activeAudio.has(tile.id)) {
    el.classList.add('playing')
  }

  if (searchQuery) el.classList.add('search-match')

  // Shortcut badge — only shown when a key is assigned
  if (tile.shortcut) {
    const badge = document.createElement('span')
    badge.className = 'shortcut-badge'
    badge.textContent = formatShortcutKey(tile.shortcut)
    el.appendChild(badge)
  }

  // Label
  const label = document.createElement('span')
  label.className = 'tile-label'
  label.textContent = tile.label || 'Untitled'
  el.appendChild(label)

  // Per-tile volume slider (always visible at bottom)
  const volSlider = document.createElement('input')
  volSlider.type = 'range'
  volSlider.className = 'tile-vol-slider'
  volSlider.min = 0
  volSlider.max = 100
  volSlider.value = Math.round((tile.volume ?? 1.0) * 100)
  volSlider.title = `Volume: ${volSlider.value}%`
  // Prevent slider interaction from triggering tile play or tile drag
  volSlider.addEventListener('click',     e => e.stopPropagation())
  volSlider.addEventListener('mousedown', e => e.stopPropagation())
  volSlider.addEventListener('dragstart', e => e.preventDefault())
  volSlider.addEventListener('input', e => {
    e.stopPropagation()
    tile.volume = volSlider.value / 100
    volSlider.title = `Volume: ${volSlider.value}%`
    saveConfig()
    const liveVol = Math.min(1, tile.volume * masterVolume)
    if (activeAudio.has(tile.id))   activeAudio.get(tile.id).volume = liveVol
    if (activeMonitor.has(tile.id)) activeMonitor.get(tile.id).volume = liveVol
    // Keep context menu in sync if open for this tile
    if (ctxTileId === tile.id) {
      ctxVolume.value = volSlider.value
      ctxVolumeValue.textContent = volSlider.value + '%'
    }
  })
  el.appendChild(volSlider)

  // Left click → play/stop
  el.addEventListener('click', (e) => {
    if (e.button === 0) playOrStopTile(tile)
  })

  // Right click → context menu
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY, tile, pageIdx)
  })

  // Drag to reorder (disabled in search results view)
  if (!searchQuery) {
    el.addEventListener('dragstart', (e) => {
      dragSrcIndex = slot
      el.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(slot))
    })
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging')
      dragSrcIndex = null
      document.querySelectorAll('.tile').forEach(t => t.classList.remove('drag-over'))
    })
    el.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      el.classList.add('drag-over')
    })
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'))
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      el.classList.remove('drag-over')
      const destSlot = parseInt(el.dataset.slot)
      if (dragSrcIndex !== null && dragSrcIndex !== destSlot) {
        swapTiles(dragSrcIndex, destSlot)
      }
    })
  }

  // Drop audio file onto existing tile
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      el.classList.add('drag-over')
    }
  })
  el.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault()
      el.classList.remove('drag-over')
      const file = e.dataTransfer.files[0]
      const ext = file.name.split('.').pop().toLowerCase()
      if (AUDIO_EXTS.includes(ext)) {
        tile.file = file.path
        tile.label = tile.label || stripExtension(file.name)
        saveConfig()
        renderTiles()
      }
    }
  })

  return el
}

function buildEmptyTileEl(slot) {
  const el = document.createElement('div')
  el.className = 'tile tile-empty'
  el.dataset.slot = slot

  const icon = document.createElement('div')
  icon.className = 'empty-icon'
  icon.textContent = '+'
  el.appendChild(icon)

  const lbl = document.createElement('div')
  lbl.className = 'empty-label'
  lbl.textContent = 'Click or drop'
  el.appendChild(lbl)

  el.addEventListener('click', () => assignTileViaFilePicker(slot))

  // Drop audio file
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files') || dragSrcIndex !== null) {
      e.preventDefault()
      el.classList.add('drag-over')
    }
  })
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'))
  el.addEventListener('drop', (e) => {
    el.classList.remove('drag-over')
    // Tile drag-to-reorder → move to empty slot
    if (dragSrcIndex !== null && !e.dataTransfer.files.length) {
      e.preventDefault()
      moveTileToSlot(dragSrcIndex, slot)
      return
    }
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      const ext = file.name.split('.').pop().toLowerCase()
      if (AUDIO_EXTS.includes(ext)) {
        createTileInSlot(slot, stripExtension(file.name), file.path)
      }
    }
  })

  return el
}

// ── Tile Operations ───────────────────────────
function assignTileViaFilePicker(slot) {
  window.api.selectFile().then(result => {
    if (!result) return
    createTileInSlot(slot, result.name, result.file)
  })
}

function createTileInSlot(slot, label, filePath, extra = {}) {
  const page = getPage()
  // Remove any existing tile at that slot
  page.tiles = page.tiles.filter(t => t.slot !== slot)
  page.tiles.push({
    id: generateId(),
    slot,
    label: label || 'Untitled',
    file: filePath,
    color: extra.color || 'default',
    volume: extra.volume ?? 1.0
  })
  saveConfig()
  renderTiles()
  setInfo(`Added: ${label}`)
}

function swapTiles(slotA, slotB) {
  const page = getPage()
  const tileA = page.tiles.find(t => t.slot === slotA)
  const tileB = page.tiles.find(t => t.slot === slotB)
  if (tileA) tileA.slot = slotB
  if (tileB) tileB.slot = slotA
  saveConfig()
  renderTiles()
}

function moveTileToSlot(fromSlot, toSlot) {
  const page = getPage()
  const tile = page.tiles.find(t => t.slot === fromSlot)
  if (tile) {
    // If destination is occupied, remove it
    page.tiles = page.tiles.filter(t => t.slot !== toSlot)
    tile.slot = toSlot
  }
  saveConfig()
  renderTiles()
}

// ── Audio Playback ────────────────────────────
async function playOrStopTile(tile) {
  if (activeAudio.has(tile.id)) {
    // Stop primary
    const audio = activeAudio.get(tile.id)
    audio.pause()
    audio.currentTime = 0
    activeAudio.delete(tile.id)
    // Stop monitor
    if (activeMonitor.has(tile.id)) {
      const mon = activeMonitor.get(tile.id)
      mon.pause()
      mon.currentTime = 0
      activeMonitor.delete(tile.id)
    }
    updateTilePlayingState(tile.id, false)
    setInfo(`Stopped: ${tile.label}`)
  } else {
    // Play
    if (!tile.file) {
      setInfo('No file assigned to this tile')
      return
    }
    const audio = new Audio(tile.file)
    const effectiveVolume = (tile.volume ?? 1.0) * masterVolume
    audio.volume = Math.min(1, Math.max(0, effectiveVolume))

    // Route to selected output device if supported
    if (selectedSinkId && typeof audio.setSinkId === 'function') {
      try { await audio.setSinkId(selectedSinkId) } catch (e) {
        console.warn('setSinkId failed:', e)
      }
    }

    audio.play().catch(err => {
      setInfo(`Error playing: ${err.message}`)
      activeAudio.delete(tile.id)
      updateTilePlayingState(tile.id, false)
    })
    activeAudio.set(tile.id, audio)
    updateTilePlayingState(tile.id, true)
    setInfo(`Playing: ${tile.label}`)

    audio.addEventListener('ended', () => {
      activeAudio.delete(tile.id)
      updateTilePlayingState(tile.id, false)
    })

    // Monitor output — play a second instance to a different device so you hear it locally
    if (monitorSinkId && monitorSinkId !== selectedSinkId) {
      const mon = new Audio(tile.file)
      mon.volume = Math.min(1, Math.max(0, effectiveVolume))
      if (typeof mon.setSinkId === 'function') {
        try { await mon.setSinkId(monitorSinkId) } catch (e) {
          console.warn('Monitor setSinkId failed:', e)
        }
      }
      mon.play().catch(() => {})
      activeMonitor.set(tile.id, mon)
      mon.addEventListener('ended', () => activeMonitor.delete(tile.id))
    }
  }
}

function updateTilePlayingState(tileId, playing) {
  const el = tileGrid.querySelector(`[data-tile-id="${tileId}"]`)
  if (!el) return
  if (playing) el.classList.add('playing')
  else el.classList.remove('playing')
}

function stopAll() {
  activeAudio.forEach((audio, tileId) => {
    audio.pause()
    audio.currentTime = 0
    updateTilePlayingState(tileId, false)
  })
  activeAudio.clear()
  activeMonitor.forEach(mon => { mon.pause(); mon.currentTime = 0 })
  activeMonitor.clear()
  setInfo('All sounds stopped')
}

// ── Master Volume ─────────────────────────────
masterVolumeSlider.addEventListener('input', () => {
  masterVolume = masterVolumeSlider.value / 100
  masterVolumeValue.textContent = masterVolumeSlider.value + '%'
  // Update all currently playing audio (primary + monitor)
  const updateVol = (audio, tileId) => {
    const page = config.pages.find(p => p.tiles.some(t => t.id === tileId))
    const tile = page?.tiles.find(t => t.id === tileId)
    audio.volume = Math.min(1, Math.max(0, (tile?.volume ?? 1.0) * masterVolume))
  }
  activeAudio.forEach(updateVol)
  activeMonitor.forEach(updateVol)
  saveConfig()
})

// ── Import Folder ─────────────────────────────
importFolderBtn.addEventListener('click', async () => {
  const result = await window.api.selectFolder()
  if (!result || !result.files) return

  const { files } = result
  let added = 0
  let importPageIndex = currentPageIndex

  for (const fileInfo of files) {
    // Find next empty slot on the current import page
    let page = config.pages[importPageIndex]
    const usedSlots = new Set(page.tiles.map(t => t.slot))
    let slot = -1
    for (let i = 0; i < getTilesPerPage(); i++) {
      if (!usedSlots.has(i)) { slot = i; break }
    }

    if (slot === -1) {
      // Page full — create a new page and continue filling it
      config.pages.push({ id: generateId(), name: `Page ${config.pages.length + 1}`, tiles: [] })
      importPageIndex = config.pages.length - 1
      currentPageIndex = importPageIndex
      page = config.pages[importPageIndex]
      slot = 0
    }

    page.tiles.push({
      id: generateId(),
      slot,
      label: fileInfo.name,
      file: fileInfo.file,
      color: 'default',
      volume: 1.0
    })
    added++
  }

  await saveConfig()
  renderPages()
  renderTiles()
  setInfo(`Imported ${added} file${added !== 1 ? 's' : ''} from folder`)
})

// ── Stop All ──────────────────────────────────
stopAllBtn.addEventListener('click', stopAll)

// ── Keyboard Shortcuts ────────────────────────

// Returns a map of normalised key string → tile (searched across all pages)
function buildShortcutMap() {
  const map = new Map()
  config.pages.forEach((page) => {
    page.tiles.forEach(tile => {
      if (tile.shortcut) {
        map.set(tile.shortcut, tile)
      }
    })
  })
  return map
}

// Human-readable label from e.code value stored in tile.shortcut
function formatShortcutKey(code) {
  if (!code) return ''
  // Letters: KeyA → A
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  // Top-row digits: Digit7 → 7
  if (/^Digit\d$/.test(code)) return code.slice(5)
  // Numpad digits: Numpad7 → Num7
  if (/^Numpad\d$/.test(code)) return 'Num' + code.slice(6)
  // Numpad operators
  const numpadOps = { NumpadAdd: 'Num+', NumpadSubtract: 'Num-', NumpadMultiply: 'Num*', NumpadDivide: 'Num/', NumpadDecimal: 'Num.', NumpadEnter: 'Num↵' }
  if (numpadOps[code]) return numpadOps[code]
  // Special keys
  const specials = { Space: 'Spc', Enter: '↵', Tab: 'Tab', Backspace: '⌫', Delete: 'Del', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins' }
  if (specials[code]) return specials[code]
  // Function keys: F5, F12, etc.
  if (/^F\d+$/.test(code)) return code
  return code
}

document.addEventListener('keydown', (e) => {
  // Don't trigger if an input/editable is focused or a modal is open
  const tag = document.activeElement?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return
  if (!shortcutModal.classList.contains('hidden')) return

  if (e.key === 'Escape') {
    hideContextMenu()
    hideRenameModal()
    return
  }

  const map = buildShortcutMap()
  if (map.has(e.code)) {
    e.preventDefault()
    playOrStopTile(map.get(e.code))
  }
})

// ── Context Menu ──────────────────────────────
function buildColorSwatches() {
  colorSwatches.innerHTML = ''
  COLORS.forEach(color => {
    const swatch = document.createElement('div')
    swatch.className = 'color-swatch'
    swatch.dataset.color = color
    swatch.title = color.charAt(0).toUpperCase() + color.slice(1)
    swatch.addEventListener('click', () => {
      if (ctxTileId == null) return
      const tile = getTileById(ctxTileId, ctxPageIndex)
      if (!tile) return
      tile.color = color
      saveConfig()
      renderTiles()
      // Update selected state
      colorSwatches.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'))
      swatch.classList.add('selected')
    })
    colorSwatches.appendChild(swatch)
  })
}

function showContextMenu(x, y, tile, pageIdx) {
  ctxTileId = tile.id
  ctxPageIndex = pageIdx

  ctxTileName.textContent = tile.label || 'Untitled'

  const vol = Math.round((tile.volume ?? 1.0) * 100)
  ctxVolume.value = vol
  ctxVolumeValue.textContent = vol + '%'

  buildColorSwatches()
  // Mark current color
  const currentColor = tile.color || 'default'
  colorSwatches.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === currentColor)
  })

  contextMenu.classList.remove('hidden')

  // Position — keep on screen
  const menuW = 220, menuH = 280
  const vpW = window.innerWidth, vpH = window.innerHeight
  contextMenu.style.left = Math.min(x, vpW - menuW) + 'px'
  contextMenu.style.top  = Math.min(y, vpH - menuH) + 'px'
}

function hideContextMenu() {
  contextMenu.classList.add('hidden')
  ctxTileId = null
  ctxPageIndex = null
}

// Context menu: volume slider
ctxVolume.addEventListener('input', () => {
  ctxVolumeValue.textContent = ctxVolume.value + '%'
  if (ctxTileId == null) return
  const tile = getTileById(ctxTileId, ctxPageIndex)
  if (!tile) return
  tile.volume = ctxVolume.value / 100
  saveConfig()
  // Update live audio if playing
  const liveVol = Math.min(1, tile.volume * masterVolume)
  if (activeAudio.has(tile.id))   activeAudio.get(tile.id).volume = liveVol
  if (activeMonitor.has(tile.id)) activeMonitor.get(tile.id).volume = liveVol
  // Sync the tile's inline slider
  const tileEl = tileGrid.querySelector(`[data-tile-id="${tile.id}"]`)
  if (tileEl) {
    const inlineSlider = tileEl.querySelector('.tile-vol-slider')
    if (inlineSlider) {
      inlineSlider.value = ctxVolume.value
      inlineSlider.title = `Volume: ${ctxVolume.value}%`
    }
  }
})

// Context menu: rename
ctxRename.addEventListener('click', () => {
  if (ctxTileId == null) return
  const tile = getTileById(ctxTileId, ctxPageIndex)
  if (!tile) return
  hideContextMenu()
  showRenameModal(tile)
})

// Context menu: set shortcut
ctxSetShortcut.addEventListener('click', () => {
  if (ctxTileId == null) return
  const tile = getTileById(ctxTileId, ctxPageIndex)
  if (!tile) return
  hideContextMenu()
  showShortcutModal(tile)
})

// Context menu: change file
ctxChangeFile.addEventListener('click', async () => {
  if (ctxTileId == null) return
  const tile = getTileById(ctxTileId, ctxPageIndex)
  if (!tile) return
  hideContextMenu()
  const result = await window.api.selectFile()
  if (!result) return
  tile.file = result.file
  saveConfig()
  renderTiles()
  setInfo(`File updated: ${tile.label}`)
})

// Context menu: show in folder
ctxShowInFolder.addEventListener('click', () => {
  if (ctxTileId == null) return
  const tile = getTileById(ctxTileId, ctxPageIndex)
  if (!tile) return
  hideContextMenu()
  window.api.showInFolder(tile.file)
})

// Context menu: delete
ctxDelete.addEventListener('click', () => {
  if (ctxTileId == null) return
  const page = config.pages[ctxPageIndex]
  if (!page) return
  page.tiles = page.tiles.filter(t => t.id !== ctxTileId)
  // Stop audio if playing
  if (activeAudio.has(ctxTileId)) {
    const audio = activeAudio.get(ctxTileId)
    audio.pause()
    activeAudio.delete(ctxTileId)
  }
  hideContextMenu()
  saveConfig()
  renderTiles()
  setInfo('Tile removed')
})

// Close context menu on outside click
document.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target)) hideContextMenu()
})
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.tile:not(.tile-empty)')) hideContextMenu()
})

// ── Rename Modal ──────────────────────────────
function showRenameModal(tile) {
  renameInput.value = tile.label || ''
  renameModal.classList.remove('hidden')
  renameInput.focus()
  renameInput.select()

  function doRename() {
    const newLabel = renameInput.value.trim()
    if (newLabel) {
      tile.label = newLabel
      saveConfig()
      renderTiles()
      setInfo(`Renamed to: ${newLabel}`)
    }
    hideRenameModal()
    cleanup()
  }

  function cleanup() {
    renameConfirmBtn.removeEventListener('click', doRename)
    renameCancelBtn.removeEventListener('click', cancel)
    renameInput.removeEventListener('keydown', keyHandler)
  }

  function cancel() { hideRenameModal(); cleanup() }

  function keyHandler(e) {
    if (e.key === 'Enter') doRename()
    if (e.key === 'Escape') cancel()
  }

  renameConfirmBtn.addEventListener('click', doRename)
  renameCancelBtn.addEventListener('click', cancel)
  renameInput.addEventListener('keydown', keyHandler)
}

function hideRenameModal() {
  renameModal.classList.add('hidden')
}

renameModal.addEventListener('click', (e) => {
  if (e.target === renameModal) hideRenameModal()
})

function showPageRenameModal(page) {
  renameInput.value = page.name || ''
  renameModal.classList.remove('hidden')
  renameInput.focus()
  renameInput.select()

  function doRename() {
    const newName = renameInput.value.trim()
    if (newName) {
      page.name = newName
      saveConfig()
      renderPages()
      setInfo(`Page renamed to: ${newName}`)
    }
    hideRenameModal()
    cleanup()
  }

  function cleanup() {
    renameConfirmBtn.removeEventListener('click', doRename)
    renameCancelBtn.removeEventListener('click', cancel)
    renameInput.removeEventListener('keydown', keyHandler)
  }

  function cancel() { hideRenameModal(); cleanup() }

  function keyHandler(e) {
    if (e.key === 'Enter') doRename()
    if (e.key === 'Escape') cancel()
  }

  renameConfirmBtn.addEventListener('click', doRename)
  renameCancelBtn.addEventListener('click', cancel)
  renameInput.addEventListener('keydown', keyHandler)
}

// ── Shortcut Modal ────────────────────────────

const BLOCKED_SHORTCUT_CODES = new Set([
  'Escape', 'F12',
  'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'ShiftLeft', 'ShiftRight',
  'CapsLock'
])

function showShortcutModal(tile) {
  shortcutModalFor.textContent = `Tile: "${tile.label || 'Untitled'}"`
  shortcutCaptureLabel.textContent = tile.shortcut
    ? `Current: ${formatShortcutKey(tile.shortcut)} — press a new key to replace`
    : 'Press any key…'
  shortcutCaptureBox.classList.remove('captured')
  shortcutModal.classList.remove('hidden')

  function onKey(e) {
    e.preventDefault()
    e.stopPropagation()
    if (BLOCKED_SHORTCUT_CODES.has(e.code)) return

    // Check for conflict (keyed by e.code)
    const map = buildShortcutMap()
    const conflict = map.get(e.code)
    if (conflict && conflict.id !== tile.id) {
      conflict.shortcut = undefined
    }

    tile.shortcut = e.code
    shortcutCaptureLabel.textContent = `Assigned: ${formatShortcutKey(e.code)}`
    shortcutCaptureBox.classList.add('captured')
    saveConfig()
    renderTiles()

    // Auto-close after brief pause so user can see the confirmation
    setTimeout(cleanup, 800)
  }

  function cleanup() {
    document.removeEventListener('keydown', onKey, true)
    shortcutClearBtn.removeEventListener('click', onClear)
    shortcutCancelBtn.removeEventListener('click', onCancel)
    shortcutModal.classList.add('hidden')
  }

  function onClear() {
    tile.shortcut = undefined
    saveConfig()
    renderTiles()
    setInfo(`Shortcut cleared for: ${tile.label}`)
    cleanup()
  }

  function onCancel() { cleanup() }

  // Use capture phase so we intercept before anything else
  document.addEventListener('keydown', onKey, true)
  shortcutClearBtn.addEventListener('click', onClear)
  shortcutCancelBtn.addEventListener('click', onCancel)
}

// ── Tile Size Toggle ──────────────────────────
function setTileSize(size) {
  if (!TILE_SIZES[size]) return
  currentTileSize = size
  config.settings.tileSize = size
  tileGrid.dataset.size = size
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === size)
  })
  saveConfig()
  renderTiles()
}

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => setTileSize(btn.dataset.size))
})

// ── Search ────────────────────────────────────

// Find all matches across all pages
function findSearchMatches(query) {
  const results = []
  config.pages.forEach((page, pageIdx) => {
    page.tiles.forEach(tile => {
      if ((tile.label || '').toLowerCase().includes(query)) {
        results.push({ tile, pageIdx })
      }
    })
  })
  return results
}

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim().toLowerCase()
  searchClearBtn.classList.toggle('hidden', !searchQuery)
  pageTabs.classList.toggle('search-active', !!searchQuery)
  tileGrid.classList.toggle('search-active', !!searchQuery)
  renderTiles()
  if (!searchQuery) setInfo('Ready')
})

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && searchQuery) {
    // Find first match across all pages, navigate there and play
    const matches = findSearchMatches(searchQuery)
    if (matches.length === 0) return
    const { tile, pageIdx } = matches[0]
    if (pageIdx !== currentPageIndex) {
      currentPageIndex = pageIdx
      renderPages()
      renderTiles()
    }
    playOrStopTile(tile)
  }
  if (e.key === 'Escape') {
    searchInput.value = ''
    searchQuery = ''
    searchClearBtn.classList.add('hidden')
    pageTabs.classList.remove('search-active')
    tileGrid.classList.remove('search-active')
    renderTiles()
    searchInput.blur()
    setInfo('Ready')
  }
})

searchClearBtn.addEventListener('click', () => {
  searchInput.value = ''
  searchQuery = ''
  searchClearBtn.classList.add('hidden')
  pageTabs.classList.remove('search-active')
  tileGrid.classList.remove('search-active')
  renderTiles()
  setInfo('Ready')
})

// ── Audio Output Device ───────────────────────
async function populateAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const outputs = devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default')
    if (outputs.length === 0) return

    const buildOptions = (selectEl, currentId, defaultLabel) => {
      selectEl.innerHTML = `<option value="">${defaultLabel}</option>`
      outputs.forEach((device, i) => {
        const opt = document.createElement('option')
        opt.value = device.deviceId
        opt.textContent = device.label || `Output device ${i + 1}`
        if (device.deviceId === currentId) opt.selected = true
        selectEl.appendChild(opt)
      })
    }

    buildOptions(audioOutputSelect,  selectedSinkId, 'Default')
    buildOptions(audioMonitorSelect, monitorSinkId,  'Off')
  } catch (e) {
    console.warn('Could not enumerate audio devices:', e)
  }
}

audioOutputSelect.addEventListener('change', () => {
  selectedSinkId = audioOutputSelect.value
  config.settings.audioOutputDeviceId = selectedSinkId
  saveConfig()
  const label = audioOutputSelect.options[audioOutputSelect.selectedIndex]?.text ?? 'Default'
  setInfo(`Output: ${label}`)
})

audioMonitorSelect.addEventListener('change', () => {
  monitorSinkId = audioMonitorSelect.value
  config.settings.monitorOutputDeviceId = monitorSinkId
  saveConfig()
  const label = audioMonitorSelect.options[audioMonitorSelect.selectedIndex]?.text ?? 'Off'
  setInfo(monitorSinkId ? `Monitor: ${label}` : 'Monitor disabled')
})

// ── Help Modal ────────────────────────────────
helpBtn.addEventListener('click', () => helpModal.classList.remove('hidden'))
helpCloseBtn.addEventListener('click', () => helpModal.classList.add('hidden'))
helpModal.addEventListener('click', (e) => {
  if (e.target === helpModal) helpModal.classList.add('hidden')
})
// Open via native Help menu
window.api.onOpenHelpModal(() => helpModal.classList.remove('hidden'))

// ── Strip extension helper ────────────────────
function stripExtension(filename) {
  return filename.replace(/\.[^/.]+$/, '')
}

// ── Init ──────────────────────────────────────
async function init() {
  await loadConfig()
  buildColorSwatches()
  // Sync size buttons to loaded setting
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === currentTileSize)
  })
  renderPages()
  renderTiles()
  await populateAudioDevices()
  setInfo('Ready — click a tile to play, right-click for options')
}

init()
