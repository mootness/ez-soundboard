/* ═══════════════════════════════════════════════
   EZ Soundboard — app.js
   Electron renderer process (Vanilla JS)
═══════════════════════════════════════════════ */

// File types Chromium can play the sound of — video files play their audio track.
// Keep in sync with MEDIA_EXTS in main.js.
const MEDIA_EXTS = [
  'mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba', 'webm', 'mka',
  'mp4', 'm4v', 'mov', 'mkv', 'ogv', '3gp'
]
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
let activeAudio = new Map()   // tileId → playing clip (audioEngine.play handle)
let masterVolume = 1.0
let autoLevel = true          // even out clip volumes (see Auto-level)
// Microphone passthrough settings; `enabled` is what the user chose, audioEngine.micActive()
// whether it is actually running
let micSettings = { enabled: false, deviceId: '', volume: 1, noiseSuppression: true }
let currentTileSize = 'medium'
let selectedSinkId = ''
let monitorSinkId = ''
let searchQuery = ''
let globalHotkeys = false
let lastHotkeySync = null   // JSON of the hotkeys last sent to the main process

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
const shortcutGlobalNote = document.getElementById('shortcutGlobalNote')
const globalHotkeysBtn   = document.getElementById('globalHotkeysBtn')

const searchInput    = document.getElementById('searchInput')
const searchClearBtn = document.getElementById('searchClearBtn')
const audioOutputSelect  = document.getElementById('audioOutputSelect')
const audioMonitorSelect = document.getElementById('audioMonitorSelect')

const helpBtn   = document.getElementById('helpBtn')
const helpModal = document.getElementById('helpModal')
const helpCloseBtn = document.getElementById('helpCloseBtn')

const micBtn         = document.getElementById('micBtn')
const ctxLevelInfo   = document.getElementById('ctxLevelInfo')
const setupChecks    = document.getElementById('setupChecks')
const micEnabledBox  = document.getElementById('micEnabled')
const micDeviceSelect = document.getElementById('micDevice')
const micVolumeSlider = document.getElementById('micVolume')
const micVolumeValue = document.getElementById('micVolumeValue')
const micNoiseBox    = document.getElementById('micNoise')
const micMeter       = document.getElementById('micMeter')
const autoLevelBox   = document.getElementById('autoLevel')
const outMeter       = document.getElementById('outMeter')
const testToneBtn    = document.getElementById('testToneBtn')

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
  infoText.title = msg   // a long message is cut off with "…" in a narrow window; hover shows it all
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
    globalHotkeys  = config.settings?.globalHotkeys ?? false
    autoLevel      = config.settings?.autoLevel ?? true
    micSettings    = { ...micSettings, ...config.settings?.mic }
  } catch (e) {
    console.error('Failed to load config:', e)
  }
}

async function saveConfig() {
  config.settings.masterVolume = masterVolume
  syncGlobalHotkeys()
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
  config.pages[idx].tiles.forEach(t => stopTileAudio(t.id))
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
  volSlider.max = 200
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
    activeAudio.get(tile.id)?.setGain(clipGain(tile))
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
      if (MEDIA_EXTS.includes(ext)) {
        tile.file = window.api.getPathForFile(file)
        tile.label = tile.label || stripExtension(file.name)
        delete tile.level
        saveConfig()
        renderTiles()
        queueLevel(tile, { urgent: true })
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
      if (MEDIA_EXTS.includes(ext)) {
        createTileInSlot(slot, stripExtension(file.name), window.api.getPathForFile(file))
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
  const tile = {
    id: generateId(),
    slot,
    label: label || 'Untitled',
    file: filePath,
    color: extra.color || 'default',
    volume: extra.volume ?? 1.0
  }
  page.tiles.push(tile)
  saveConfig()
  renderTiles()
  setInfo(`Added: ${label}`)
  queueLevel(tile, { urgent: true })
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
// Clips play through audioEngine (audio.js), which sends each one to the Output device and
// the Monitor, with the volumes below and a limiter.

// Stops a tile on both the primary and monitor outputs
function stopTileAudio(tileId) {
  activeAudio.get(tileId)?.stop()
  activeAudio.delete(tileId)
  updateTilePlayingState(tileId, false)
}

// A clip's volume: its auto-level adjustment times its own volume (the master volume applies
// on top, in the engine)
function clipGain(tile) {
  return levelGain(tile) * (tile.volume ?? 1.0)
}

function playOrStopTile(tile) {
  if (activeAudio.has(tile.id)) {
    stopTileAudio(tile.id)
    setInfo(`Stopped: ${tile.label}`)
    return
  }
  if (!tile.file) {
    setInfo('No file assigned to this tile')
    return
  }
  // Not measured yet: plays unlevelled this once, and is measured next
  if (!tile.level) queueLevel(tile, { urgent: true })

  const handle = audioEngine.play(tile.file, clipGain(tile))
  const audio = handle.element
  // Cleans up — unless the tile has been stopped and played again since
  const finish = () => {
    if (activeAudio.get(tile.id) === handle) stopTileAudio(tile.id)
    else handle.stop()
  }
  handle.start().catch(err => {
    if (err.name === 'AbortError') return // stopped before it started
    finish()
    setInfo(err.name === 'NotSupportedError'
      ? `Can't play "${tile.label}" — the file is missing or its format isn't supported`
      : `Error playing: ${err.message}`)
  })
  activeAudio.set(tile.id, handle)
  updateTilePlayingState(tile.id, true)
  setInfo(`Playing: ${tile.label}`)

  audio.addEventListener('ended', finish)

  // A video can play with no sound when it has no audio track, or one Chromium can't
  // decode (e.g. AC3/DTS in .mkv) — stop it and say so instead of "playing" silently
  audio.addEventListener('playing', () => {
    setTimeout(() => {
      if (activeAudio.get(tile.id) === handle && audio.webkitAudioDecodedByteCount === 0) {
        stopTileAudio(tile.id)
        setInfo(`No playable sound in "${tile.label}" — its audio track is missing or in an unsupported format`)
      }
    }, 1000)
  }, { once: true })
}

function updateTilePlayingState(tileId, playing) {
  const el = tileGrid.querySelector(`[data-tile-id="${tileId}"]`)
  if (!el) return
  if (playing) el.classList.add('playing')
  else el.classList.remove('playing')
}

function stopAll() {
  for (const tileId of [...activeAudio.keys()]) stopTileAudio(tileId)
  setInfo('All sounds stopped')
}

// ── Master Volume ─────────────────────────────
masterVolumeSlider.addEventListener('input', () => {
  masterVolume = masterVolumeSlider.value / 100
  masterVolumeValue.textContent = masterVolumeSlider.value + '%'
  audioEngine.setMaster(masterVolume)
  saveConfig()
})

// ── Auto-level ────────────────────────────────
// Each clip's loudness is measured once, in the background, and kept on the tile as
// tile.level = { lufs, peak, file }, where `file` identifies the measured version of the file
// (size and modified time) so a changed file is measured again. A clip that can't be measured
// keeps { error, file } instead and plays unlevelled.
const levelQueue = []
let levelRunning = false

// Linear gain that brings a tile's clip to the common loudness (1 when off or not measured)
function levelGain(tile) {
  if (!autoLevel || !tile.level || tile.level.error) return 1
  return audioEngine.dbToGain(audioEngine.levelDb(tile.level))
}

function queueLevel(tile, { urgent = false } = {}) {
  if (!tile.file) return
  const queued = levelQueue.indexOf(tile)
  if (queued >= 0) {
    if (!urgent) return
    levelQueue.splice(queued, 1)
  }
  if (urgent) levelQueue.unshift(tile)
  else levelQueue.push(tile)
  runLevelQueue()
}

// A clip's length in seconds from its metadata: NaN if it can't be read, Infinity if unknown
function mediaDuration(file) {
  return new Promise((resolve) => {
    const el = new Audio()
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      el.removeAttribute('src')
      el.load()
      resolve(value)
    }
    const timer = setTimeout(() => done(NaN), 10000)
    el.preload = 'metadata'
    el.addEventListener('loadedmetadata', () => done(el.duration), { once: true })
    el.addEventListener('error', () => done(NaN), { once: true })
    el.src = file
  })
}

// Measures a tile's clip unless the same file was measured before. Resolves true if
// tile.level changed.
async function measureTile(tile) {
  const file = tile.file
  const stat = await window.api.statMedia(file)
  if (!stat) {
    if (tile.level?.error === 'missing') return false
    tile.level = { error: 'missing' } // measured again once the file is back
    return true
  }
  const fingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}`
  if (tile.level?.file === fingerprint) return false

  let level
  const duration = await mediaDuration(file)
  if (Number.isNaN(duration)) {
    level = { error: 'unreadable' }
  } else if (duration > audioEngine.MAX_MEASURE_SECONDS) {
    level = { error: 'too-long' }
  } else {
    const read = await window.api.readMedia(file)
    if (read.error) {
      level = { error: read.error }
    } else {
      try {
        const bytes = read.bytes.buffer.slice(read.bytes.byteOffset, read.bytes.byteOffset + read.bytes.byteLength)
        const { lufs, peak } = await audioEngine.measure(bytes, duration)
        level = Number.isFinite(lufs) ? { lufs: +lufs.toFixed(1), peak: +peak.toFixed(1) } : { error: 'silent' }
      } catch {
        level = { error: 'unreadable' }
      }
    }
  }
  if (tile.file !== file) return false // given another file meanwhile, which is queued too
  tile.level = { ...level, file: fingerprint }
  return true
}

async function runLevelQueue() {
  if (levelRunning) return
  levelRunning = true
  let changed = 0
  while (levelQueue.length) {
    const tile = levelQueue.shift()
    try {
      if (await measureTile(tile)) {
        changed++
        if (ctxTileId === tile.id) showLevelInfo(tile)
        if (changed % 10 === 0) saveConfig()
      }
    } catch (e) {
      console.warn('Could not measure', tile.file, e)
    }
  }
  levelRunning = false
  if (changed % 10) saveConfig()
}

// The auto-level line in the tile menu
function showLevelInfo(tile) {
  const level = tile.level
  let text = ''
  if (!autoLevel) text = 'Auto-level is off'
  else if (!level) text = tile.file ? 'Auto-level: measuring…' : ''
  else if (level.error === 'missing') text = 'Auto-level: file not found'
  else if (level.error === 'too-long' || level.error === 'too-large') text = 'Auto-level: too long to measure'
  else if (level.error === 'silent') text = 'Auto-level: clip is silent'
  else if (level.error) text = "Auto-level: couldn't measure this file"
  else {
    const db = audioEngine.levelDb(level)
    text = `Auto-level: ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
  }
  ctxLevelInfo.textContent = text
}

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

    const tile = {
      id: generateId(),
      slot,
      label: fileInfo.name,
      file: fileInfo.file,
      color: 'default',
      volume: 1.0
    }
    page.tiles.push(tile)
    queueLevel(tile)
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

// Modifier names held during a key event, in the order they're stored
function heldModifiers(e) {
  const mods = []
  if (e.ctrlKey)  mods.push('Ctrl')
  if (e.altKey)   mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  return mods
}

// Shortcut string stored in tile.shortcut: held modifiers then e.code, e.g. "Ctrl+Alt+Digit1".
// A plain key stays a bare e.code, so shortcuts saved before modifier support still match.
// The Windows key isn't supported as a modifier.
function shortcutFromEvent(e) {
  if (e.metaKey) return null
  return [...heldModifiers(e), e.code].join('+')
}

// Human-readable label for a stored shortcut, e.g. "Alt+Digit1" → "Alt+1"
function formatShortcutKey(shortcut) {
  if (!shortcut) return ''
  const parts = shortcut.split('+')
  const code = parts.pop()
  return [...parts, formatKeyCode(code)].join('+')
}

// Human-readable label from an e.code value
function formatKeyCode(code) {
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

  // Holding a key auto-repeats keydown, which would toggle the tile on and off
  if (e.repeat) return

  const tile = buildShortcutMap().get(shortcutFromEvent(e))
  if (tile) {
    e.preventDefault()
    playOrStopTile(tile)
  }
})

// ── Global Hotkeys ────────────────────────────

// e.code → Electron accelerator key, for keys that aren't a simple pattern (see acceleratorKey)
const ACCELERATOR_KEYS = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`'
}

function acceleratorKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return 'num' + code.slice(6)
  if (/^F\d+$/.test(code)) return code
  return ACCELERATOR_KEYS[code] ?? null
}

// Electron accelerator for a stored shortcut ("Alt+Digit1" → "Alt+1"), or null if the key has none
function toAccelerator(shortcut) {
  const parts = shortcut.split('+')
  const key = acceleratorKey(parts.pop())
  return key ? [...parts, key].join('+') : null
}

// Registers every tile shortcut system-wide while global hotkeys are on. Nothing is registered
// while the shortcut dialog is open, so a key that's already bound still reaches the dialog.
// Only calls the main process when the set of hotkeys actually changes.
async function syncGlobalHotkeys() {
  const hotkeys = []
  if (globalHotkeys && shortcutModal.classList.contains('hidden')) {
    buildShortcutMap().forEach((_, shortcut) => {
      hotkeys.push({ shortcut, accelerator: toAccelerator(shortcut) })
    })
  }
  const key = JSON.stringify(hotkeys)
  if (key === lastHotkeySync) return
  lastHotkeySync = key

  const failed = await window.api.setGlobalHotkeys(hotkeys.filter(h => h.accelerator))
  const focusedOnly = [...hotkeys.filter(h => !h.accelerator).map(h => h.shortcut), ...failed]
  if (focusedOnly.length) {
    setInfo(`Only work while focused (key unsupported or used by another app): ${focusedOnly.map(formatShortcutKey).join(', ')}`)
  }
}

function updateGlobalHotkeysBtn() {
  globalHotkeysBtn.classList.toggle('active', globalHotkeys)
  globalHotkeysBtn.setAttribute('aria-pressed', String(globalHotkeys))
}

globalHotkeysBtn.addEventListener('click', () => {
  globalHotkeys = !globalHotkeys
  config.settings.globalHotkeys = globalHotkeys
  updateGlobalHotkeysBtn()
  setInfo(globalHotkeys
    ? 'Global hotkeys on — shortcuts work even when other apps are focused'
    : 'Global hotkeys off — shortcuts work only while EZ Soundboard is focused')
  saveConfig()
})

window.api.onGlobalHotkey((shortcut) => {
  const tile = buildShortcutMap().get(shortcut)
  if (tile) playOrStopTile(tile)
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
  showLevelInfo(tile)

  buildColorSwatches()
  // Mark current color
  const currentColor = tile.color || 'default'
  colorSwatches.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === currentColor)
  })

  contextMenu.classList.remove('hidden')

  // Position — keep the whole menu inside the window. Its size is measured, not assumed (the
  // height varies with the layout), and from the corner so its last position can't squeeze it.
  const margin = 6
  contextMenu.style.left = contextMenu.style.top = '0px'
  const { width, height } = contextMenu.getBoundingClientRect()
  contextMenu.style.left = Math.max(margin, Math.min(x, window.innerWidth - width - margin)) + 'px'
  contextMenu.style.top  = Math.max(margin, Math.min(y, window.innerHeight - height - margin)) + 'px'
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
  activeAudio.get(tile.id)?.setGain(clipGain(tile))
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
  delete tile.level
  saveConfig()
  renderTiles()
  setInfo(`File updated: ${tile.label}`)
  queueLevel(tile, { urgent: true })
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
  stopTileAudio(ctxTileId)
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
// Resizing or snapping the window could leave an open menu outside it
window.addEventListener('resize', hideContextMenu)

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

const MODIFIER_CODES = new Set([
  'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'ShiftLeft', 'ShiftRight'
])

// Keys that can't be a shortcut with any modifiers
const BLOCKED_SHORTCUT_CODES = new Set(['F12', 'CapsLock'])
// Combos Windows reserves (Alt+F4 closes the window)
const BLOCKED_SHORTCUTS = new Set(['Alt+F4'])

function showShortcutModal(tile) {
  const prompt = tile.shortcut
    ? `Current: ${formatShortcutKey(tile.shortcut)} — press a new key to replace`
    : 'Press any key…'
  shortcutModalFor.textContent = `Tile: "${tile.label || 'Untitled'}"`
  shortcutCaptureLabel.textContent = prompt
  shortcutCaptureBox.classList.remove('captured')
  shortcutGlobalNote.classList.toggle('hidden', !globalHotkeys)
  shortcutModal.classList.remove('hidden')
  syncGlobalHotkeys()

  // While only modifiers are held, show them (e.g. "Alt+…") so the user knows they registered
  function showHeldModifiers(e) {
    const mods = heldModifiers(e)
    shortcutCaptureLabel.textContent = mods.length ? mods.join('+') + '+…' : prompt
  }

  function onKey(e) {
    e.preventDefault()
    e.stopPropagation()
    if (e.code === 'Escape') { cleanup(); return }
    if (MODIFIER_CODES.has(e.code)) { showHeldModifiers(e); return }

    const shortcut = shortcutFromEvent(e)
    if (!shortcut || BLOCKED_SHORTCUT_CODES.has(e.code) || BLOCKED_SHORTCUTS.has(shortcut)) return

    // Check for conflict
    const conflict = buildShortcutMap().get(shortcut)
    if (conflict && conflict.id !== tile.id) {
      conflict.shortcut = undefined
    }

    tile.shortcut = shortcut
    shortcutCaptureLabel.textContent = `Assigned: ${formatShortcutKey(shortcut)}`
    shortcutCaptureBox.classList.add('captured')
    saveConfig()
    renderTiles()

    // Auto-close after brief pause so user can see the confirmation
    setTimeout(cleanup, 800)
  }

  function onKeyUp(e) {
    if (MODIFIER_CODES.has(e.code) && !shortcutCaptureBox.classList.contains('captured')) {
      showHeldModifiers(e)
    }
  }

  function cleanup() {
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('keyup', onKeyUp, true)
    shortcutClearBtn.removeEventListener('click', onClear)
    shortcutCancelBtn.removeEventListener('click', onCancel)
    shortcutModal.classList.add('hidden')
    syncGlobalHotkeys()
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
  document.addEventListener('keyup', onKeyUp, true)
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

// ── Audio Devices ─────────────────────────────
// VB-Audio's virtual cables (VB-Cable, Hi-Fi Cable, CABLE-A/B). Windows names the playback side
// "CABLE Input (VB-Audio Virtual Cable)" or "Speakers (VB-Audio Virtual Cable)".
const CABLE_RE = /VB-Audio|\bCABLE\b/i
let audioDevices = { outputs: [], inputs: [] }

async function populateAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const outputs = devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default')
    // 'default' and 'communications' are Windows' aliases for devices that are also listed by name
    const inputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    audioDevices = { outputs, inputs }

    const buildOptions = (selectEl, list, currentId, defaultLabel, fallbackName) => {
      selectEl.innerHTML = ''
      const none = document.createElement('option')
      none.value = ''
      none.textContent = defaultLabel
      selectEl.appendChild(none)
      list.forEach((device, i) => {
        const opt = document.createElement('option')
        opt.value = device.deviceId
        opt.textContent = device.label || `${fallbackName} ${i + 1}`
        if (device.deviceId === currentId) opt.selected = true
        selectEl.appendChild(opt)
      })
    }

    if (outputs.length) {
      buildOptions(audioOutputSelect,  outputs, selectedSinkId, 'Default', 'Output device')
      buildOptions(audioMonitorSelect, outputs, monitorSinkId,  'Off', 'Output device')
    }
    // Not the cable's own output: passing that through would feed the soundboard back into itself
    buildOptions(micDeviceSelect, inputs.filter(d => !CABLE_RE.test(d.label)), micSettings.deviceId, 'Default microphone', 'Microphone')
  } catch (e) {
    console.warn('Could not enumerate audio devices:', e)
  }
  refreshSetup()
}

// Headsets plugged in or out, VB-Cable installed, ...
navigator.mediaDevices?.addEventListener('devicechange', populateAudioDevices)

audioOutputSelect.addEventListener('change', async () => {
  selectedSinkId = audioOutputSelect.value
  config.settings.audioOutputDeviceId = selectedSinkId
  saveConfig()
  const label = audioOutputSelect.options[audioOutputSelect.selectedIndex]?.text ?? 'Default'
  setInfo(`Output: ${label}`)
  if (!(await audioEngine.setOutput('main', selectedSinkId))) setInfo(`Couldn't switch the Output to ${label}`)
  refreshSetup()
})

audioMonitorSelect.addEventListener('change', async () => {
  monitorSinkId = audioMonitorSelect.value
  config.settings.monitorOutputDeviceId = monitorSinkId
  saveConfig()
  const label = audioMonitorSelect.options[audioMonitorSelect.selectedIndex]?.text ?? 'Off'
  setInfo(monitorSinkId ? `Monitor: ${label}` : 'Monitor disabled')
  if (!(await audioEngine.setOutput('monitor', monitorSinkId || null))) setInfo(`Couldn't switch the Monitor to ${label}`)
  refreshSetup()
})

// ── Microphone Passthrough ────────────────────
// Mixes the user's real mic into the Output, so with Discord's input set to the cable, Discord
// hears both their voice and the clips.
function micErrorMessage(e) {
  switch (e.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Windows blocked the microphone — Settings → Privacy & security → Microphone → turn on "Let desktop apps access your microphone"'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return "That microphone isn't connected — pick another in Discord setup"
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy or unavailable — another app may be using it'
    default:
      return `Couldn't start the microphone: ${e.message}`
  }
}

function saveMicSettings() {
  config.settings.mic = { ...micSettings }
  saveConfig()
}

async function startMic() {
  try {
    const label = await audioEngine.startMic({
      deviceId: micSettings.deviceId,
      noiseSuppression: micSettings.noiseSuppression,
      volume: micSettings.volume,
      onEnded: () => {
        micSettings.enabled = false
        saveMicSettings()
        setInfo('Your microphone was disconnected — mic passthrough stopped')
        updateMicUI()
      }
    })
    if (CABLE_RE.test(label)) {
      // Windows' default recording device is often set to the cable for Discord
      audioEngine.stopMic()
      micSettings.enabled = false
      saveMicSettings()
      setInfo('Your default microphone is the virtual cable — pick your real microphone in Discord setup')
    } else {
      setInfo(`Mic passthrough on: ${label}`)
    }
  } catch (e) {
    micSettings.enabled = false
    saveMicSettings()
    setInfo(micErrorMessage(e))
  }
  updateMicUI()
}

async function setMicEnabled(enabled) {
  micSettings.enabled = enabled
  saveMicSettings()
  if (enabled) {
    await startMic()
  } else {
    audioEngine.stopMic()
    setInfo('Mic passthrough off')
    updateMicUI()
  }
}

function updateMicUI() {
  const on = audioEngine.micActive()
  micBtn.classList.toggle('active', on)
  micBtn.setAttribute('aria-pressed', String(on))
  micEnabledBox.checked = micSettings.enabled
  refreshSetup()
}

micBtn.addEventListener('click', () => setMicEnabled(!micSettings.enabled))
micEnabledBox.addEventListener('change', () => setMicEnabled(micEnabledBox.checked))

micDeviceSelect.addEventListener('change', () => {
  micSettings.deviceId = micDeviceSelect.value
  saveMicSettings()
  if (micSettings.enabled) startMic()
})

micNoiseBox.addEventListener('change', () => {
  micSettings.noiseSuppression = micNoiseBox.checked
  saveMicSettings()
  if (micSettings.enabled) startMic()
})

micVolumeSlider.addEventListener('input', () => {
  micSettings.volume = micVolumeSlider.value / 100
  micVolumeValue.textContent = micVolumeSlider.value + '%'
  audioEngine.setMicVolume(micSettings.volume)
  saveMicSettings()
})

// ── Discord Setup (the help window) ───────────
// Live checks of everything between the soundboard and Discord that the app can see, plus the
// mic, volume and Discord settings.
let callDucking = 'unknown' // Windows' communications setting, read when the window opens

function setupStatus() {
  const rows = []
  const cable = audioDevices.outputs.find(d => CABLE_RE.test(d.label))
  const labelOf = (id) => audioDevices.outputs.find(d => d.deviceId === id)?.label
  const outputLabel = labelOf(selectedSinkId)
  const outputIsCable = CABLE_RE.test(outputLabel || '')

  if (!cable) {
    rows.push({ state: 'bad', text: "VB-Cable isn't installed, so Discord can't hear the soundboard.",
      action: { label: 'Get VB-Cable', run: () => window.api.openExternal('https://vb-audio.com/Cable/') } })
  } else if (outputIsCable) {
    rows.push({ state: 'ok', text: `Output goes to ${outputLabel}` })
  } else {
    rows.push({ state: 'warn', text: `Output is ${outputLabel || 'your default device'} — Discord won't hear clips.`,
      action: { label: 'Use VB-Cable', run: () => {
        audioOutputSelect.value = cable.deviceId
        audioOutputSelect.dispatchEvent(new Event('change'))
      } } })
  }

  if (!monitorSinkId) {
    rows.push({ state: 'info', text: "Monitor is off — you won't hear clips yourself. Pick your headphones as the Monitor in the toolbar." })
  } else if (monitorSinkId === selectedSinkId) {
    rows.push({ state: 'warn', text: 'Monitor is the same device as the Output, so it does nothing.' })
  } else {
    rows.push({ state: 'ok', text: `You hear clips on ${labelOf(monitorSinkId) || 'your Monitor device'}` })
  }

  if (audioEngine.micActive()) {
    rows.push({ state: 'ok', text: 'Your mic goes to Discord through the soundboard' })
  } else if (outputIsCable) {
    rows.push({ state: 'warn', text: 'Discord only hears clips, not your voice — turn on "Send my microphone" below.' })
  }

  const ducking = { mute: 'mutes other sounds', reduce80: 'turns other sounds down 80%', reduce50: 'turns other sounds down 50%' }[callDucking]
  if (ducking) {
    rows.push({ state: 'warn', text: `During calls, Windows ${ducking}, which can include the soundboard. Choose "Do nothing" on the Communications tab.`,
      action: { label: 'Open sound settings', run: () => window.api.openSoundSettings() } })
  } else if (callDucking === 'off') {
    rows.push({ state: 'ok', text: "Windows won't turn the soundboard down during calls" })
  }

  return { rows, needsAttention: !!cable && !outputIsCable }
}

function refreshSetup() {
  const { rows, needsAttention } = setupStatus()
  // A dot on the help button when the cable is installed but not used
  helpBtn.classList.toggle('attention', needsAttention)
  const icons = { ok: '✓', warn: '!', bad: '✕', info: 'i' }
  setupChecks.innerHTML = ''
  for (const row of rows) {
    const el = document.createElement('div')
    el.className = `setup-check ${row.state}`
    const icon = document.createElement('span')
    icon.className = 'setup-icon'
    icon.textContent = icons[row.state]
    const text = document.createElement('span')
    text.className = 'setup-text'
    text.textContent = row.text
    el.append(icon, text)
    if (row.action) {
      const btn = document.createElement('button')
      btn.className = 'btn btn-secondary btn-sm'
      btn.textContent = row.action.label
      btn.addEventListener('click', row.action.run)
      el.appendChild(btn)
    }
    setupChecks.appendChild(el)
  }
}

// Level meters, drawn while the window is open
function setMeter(el, db) {
  const percent = Number.isFinite(db) ? Math.max(0, Math.min(100, (db + 60) / 60 * 100)) : 0
  el.style.width = percent + '%'
  el.classList.toggle('hot', db > -1)
}
function drawMeters() {
  if (helpModal.classList.contains('hidden')) return
  const { output, mic } = audioEngine.levels()
  setMeter(outMeter, output)
  setMeter(micMeter, mic)
  requestAnimationFrame(drawMeters)
}

function syncSetupControls() {
  micEnabledBox.checked = micSettings.enabled
  micDeviceSelect.value = micSettings.deviceId
  micVolumeSlider.value = Math.round(micSettings.volume * 100)
  micVolumeValue.textContent = micVolumeSlider.value + '%'
  micNoiseBox.checked = micSettings.noiseSuppression
  autoLevelBox.checked = autoLevel
}

async function openSetup() {
  syncSetupControls()
  refreshSetup()
  const wasHidden = helpModal.classList.contains('hidden')
  helpModal.classList.remove('hidden')
  if (wasHidden) requestAnimationFrame(drawMeters)
  callDucking = await window.api.getCallDucking()
  refreshSetup()
}
function closeSetup() {
  helpModal.classList.add('hidden')
}

helpBtn.addEventListener('click', openSetup)
helpCloseBtn.addEventListener('click', closeSetup)
helpModal.addEventListener('click', (e) => {
  if (e.target === helpModal) closeSetup()
})
// Open via native Help menu
window.api.onOpenHelpModal(openSetup)

testToneBtn.addEventListener('click', () => {
  audioEngine.playTestTone()
  setInfo('Test sound played to your Output (and Monitor)')
})

autoLevelBox.addEventListener('change', () => {
  autoLevel = autoLevelBox.checked
  config.settings.autoLevel = autoLevel
  saveConfig()
  // Sounds already playing take the new volume
  for (const page of config.pages) {
    for (const tile of page.tiles) activeAudio.get(tile.id)?.setGain(clipGain(tile))
  }
  setInfo(autoLevel ? 'Auto-level on: clips play at an even volume' : 'Auto-level off: clips play at their own volume')
})
// Status-bar messages from the main process (e.g. Help > Copy Diagnostic Info)
window.api.onShowInfo(setInfo)

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
  updateGlobalHotkeysBtn()
  audioEngine.setMaster(masterVolume)
  audioEngine.setOutput('main', selectedSinkId)
  audioEngine.setOutput('monitor', monitorSinkId || null)
  renderPages()
  renderTiles()
  await populateAudioDevices()
  syncSetupControls()
  setInfo((await window.api.getStartupNotice()) || 'Ready — click a tile to play, right-click for options')
  if (micSettings.enabled) startMic()
  syncGlobalHotkeys()
  // Measure any clips not measured yet, or whose files changed since
  for (const page of config.pages) {
    for (const tile of page.tiles) queueLevel(tile)
  }
}

init()

// ── Updater UI ───────────────────────────────
;(function initUpdaterUI() {
  const updateBar = document.getElementById('updateBar')
  const updateMessage = document.getElementById('updateMessage')
  const updateActionBtn = document.getElementById('updateActionBtn')
  const updateDismissBtn = document.getElementById('updateDismissBtn')
  const RELEASES_URL = 'https://github.com/mootness/ez-soundboard/releases'
  let hideTimer = null

  // Shows a message in the update bar, with at most one action button; `hideAfter` (ms) is for
  // messages that don't need the user to do anything
  function show(message, { action, hideAfter } = {}) {
    clearTimeout(hideTimer)
    updateMessage.textContent = message
    updateActionBtn.classList.toggle('hidden', !action)
    if (action) {
      updateActionBtn.textContent = action.label
      updateActionBtn.onclick = action.run
    }
    updateBar.classList.remove('hidden')
    if (hideAfter) hideTimer = setTimeout(() => updateBar.classList.add('hidden'), hideAfter)
  }

  // The way out when updating in the app isn't possible on this PC
  const downloadManually = {
    label: 'Download manually',
    run: () => window.api.openExternal(`${RELEASES_URL}/latest`)
  }
  // With Smart App Control on, a manual download is blocked just the same, so explain instead
  const smartAppControlHelp = {
    label: 'What can I do?',
    run: () => window.api.openExternal('https://github.com/mootness/ez-soundboard#troubleshooting-updates')
  }
  // Errors from the network layer can run to many lines of headers
  const brief = (text) => String(text).split('\n')[0].slice(0, 140)

  window.api.onUpdaterStatus((data) => {
    switch (data.status) {
      case 'checking':
        show('Checking for updates…')
        break
      case 'available':
        show(`Update available: v${data.version}`, {
          action: {
            label: 'Update now',
            run: () => {
              show('Downloading update…')
              window.api.updaterDownload()
            }
          }
        })
        break
      case 'not-available':
        show('You\'re on the latest version.', { hideAfter: 4000 })
        break
      case 'downloading':
        show(`Downloading update… ${data.percent}%`)
        break
      case 'downloaded':
        // Only after a slow download; a quick one goes straight to 'installing'
        show(`v${data.version} is ready — restart to install it.`, {
          action: { label: 'Restart', run: () => window.api.updaterInstall() }
        })
        break
      case 'installing':
        show(`Installing v${data.version} — the app will close and reopen in a few seconds…`)
        break
      case 'updated':
        show(`Updated to v${data.version}.`, {
          action: { label: 'What\'s new', run: () => window.api.openExternal(`${RELEASES_URL}/tag/v${data.version}`) },
          hideAfter: 15000
        })
        break
      case 'install-failed':
        if (data.smartAppControl) {
          show(`Windows Smart App Control blocked the v${data.version} update — it only lets code-signed apps install.`, { action: smartAppControlHelp })
        } else {
          show(data.reason
            ? `Couldn't start the v${data.version} installer — Windows or your antivirus blocked it (${brief(data.reason)}).`
            : `The update to v${data.version} didn't install.`, { action: downloadManually })
        }
        break
      case 'download-failed':
        show(`Couldn't download the update: ${brief(data.message)}`, { action: downloadManually })
        break
      case 'error':
        show(`Update error: ${brief(data.message)}`, { hideAfter: 6000 })
        break
    }
  })

  updateDismissBtn.addEventListener('click', () => {
    clearTimeout(hideTimer)
    updateBar.classList.add('hidden')
  })
})()
