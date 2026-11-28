/* ═══════════════════════════════════════════════
   EZ Soundboard — audio.js
   Sound engine (Web Audio): outputs with headroom and a limiter, per-clip
   loudness measurement for auto-levelling, microphone passthrough, level
   meters and a test tone. Loaded before app.js, which uses `audioEngine`.
═══════════════════════════════════════════════ */

const audioEngine = (() => {
  // Auto-level brings every clip to this loudness before the tile and master volumes apply —
  // about the level of speech on streaming platforms and podcasts
  const TARGET_LUFS = -16
  // Bounds on the auto-level adjustment. A boost is also held back so a clip's loudest peak
  // goes no more than PEAK_HEADROOM_DB past full scale, which the limiter absorbs cleanly.
  const MAX_BOOST_DB = 20
  const MAX_CUT_DB = 20
  const PEAK_HEADROOM_DB = 3

  const dbToGain = (db) => Math.pow(10, db / 20)
  const gainToDb = (gain) => 20 * Math.log10(Math.max(gain, 1e-9))

  // ── Outputs ────────────────────────────────
  // "main" goes to the Output device (the virtual cable, so Discord hears it) and also carries
  // the microphone; "monitor" goes to the user's own headphones and carries clips only.
  const buses = { main: null, monitor: null }
  const sinks = { main: '', monitor: null }   // device ids: '' = system default, null = off
  // Per-output volume on top of everything else: the monitor's lets the user hear clips
  // quieter (or louder) than Discord does. The main output's stays at 1.
  const volumes = { main: 1, monitor: 1 }
  let master = 1

  // Linear up to 0.9, then eases into a ceiling just under full scale
  const SOFT_CLIP_CURVE = (() => {
    const size = 4097, knee = 0.9
    const curve = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1)) * 2 - 1
      const a = Math.abs(x)
      curve[i] = Math.sign(x) * (a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)))
    }
    return curve
  })()

  // How every output ends: a fast limiter just under full scale (inaudible on normal clips,
  // stops boosted ones from clipping), then a soft clipper for the rare peak it's too slow for
  function buildLimiter(ctx) {
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -2
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0
    limiter.release.value = 0.15
    const clipper = ctx.createWaveShaper()
    clipper.curve = SOFT_CLIP_CURVE
    clipper.oversample = '2x'
    limiter.connect(clipper)
    return { input: limiter, output: clipper }
  }

  function createBus(name, sinkId) {
    let ctx
    try {
      ctx = new AudioContext({ latencyHint: 'interactive', sinkId })
    } catch (e) {
      console.warn('Output device unavailable, using the default device:', e)
      ctx = new AudioContext({ latencyHint: 'interactive' })
    }
    const clips = ctx.createGain()   // every clip, at the master volume
    clips.gain.value = master
    const mix = ctx.createGain()     // clips + microphone
    const volume = ctx.createGain()  // this output's own volume (before the limiter, so it's protected too)
    volume.gain.value = volumes[name]
    const limit = buildLimiter(ctx)
    const meter = ctx.createAnalyser()
    meter.fftSize = 2048
    clips.connect(mix)
    mix.connect(volume)
    volume.connect(limit.input)
    limit.output.connect(ctx.destination)
    limit.output.connect(meter)
    ctx.resume().catch(() => {})
    return { ctx, clips, mix, volume, meter }
  }

  // An output's bus, created on first use; null when the monitor is off or would only
  // duplicate the main output
  function bus(name) {
    if (name === 'monitor' && (sinks.monitor == null || sinks.monitor === sinks.main)) return null
    if (!buses[name]) buses[name] = createBus(name, sinks[name])
    return buses[name]
  }

  function wake(b) {
    if (b.ctx.state !== 'running') b.ctx.resume().catch(() => {})
  }

  function closeMonitorIfRedundant() {
    if (buses.monitor && (sinks.monitor == null || sinks.monitor === sinks.main)) {
      buses.monitor.ctx.close().catch(() => {})
      buses.monitor = null
    }
  }

  // Points an output at a device ('' = system default; for the monitor, null = off).
  // Resolves false if the device couldn't be used.
  async function setOutput(name, sinkId) {
    sinks[name] = sinkId
    closeMonitorIfRedundant()
    const b = buses[name]
    if (!b) return true
    try {
      await b.ctx.setSinkId(sinkId ?? '')
      return true
    } catch (e) {
      console.warn(`Could not switch the ${name} output:`, e)
      return false
    }
  }

  function setMaster(gain) {
    master = gain
    for (const b of Object.values(buses)) {
      if (b) b.clips.gain.setTargetAtTime(gain, b.ctx.currentTime, 0.015)
    }
  }

  // One output's own volume, e.g. how loud the user hears clips on the monitor
  function setOutputVolume(name, gain) {
    volumes[name] = gain
    const b = buses[name]
    if (b) b.volume.gain.setTargetAtTime(gain, b.ctx.currentTime, 0.015)
  }

  // ── Clips ──────────────────────────────────
  function release(voice) {
    voice.element.pause()
    voice.element.removeAttribute('src')
    voice.element.load()
    voice.source.disconnect()
    voice.level.disconnect()
  }

  // Prepares a file on the main output and, if on, the monitor. `gain` is linear (auto-level ×
  // tile volume); the master volume applies on top. Returns a handle to start and control it.
  function play(file, gain) {
    const voices = []
    for (const name of ['main', 'monitor']) {
      const b = bus(name)
      if (!b) continue
      const element = new Audio(file)
      const source = b.ctx.createMediaElementSource(element)
      const level = b.ctx.createGain()
      level.gain.value = gain
      source.connect(level)
      level.connect(b.clips)
      voices.push({ element, source, level, bus: b })
    }
    const [main, ...others] = voices
    return {
      element: main.element, // the main output's element: its events say when playback ends or fails
      start() {
        for (const v of voices) wake(v.bus)
        for (const v of others) v.element.play().catch(() => {})
        return main.element.play()
      },
      setGain(value) {
        for (const v of voices) v.level.gain.setTargetAtTime(value, v.bus.ctx.currentTime, 0.015)
      },
      stop() {
        for (const v of voices) release(v)
      }
    }
  }

  // A short two-note chime on both outputs, for checking the setup
  function playTestTone() {
    for (const name of ['main', 'monitor']) {
      const b = bus(name)
      if (!b) continue
      wake(b)
      const start = b.ctx.currentTime + 0.03
      for (const [frequency, offset] of [[660, 0], [880, 0.16]]) {
        const t = start + offset
        const osc = b.ctx.createOscillator()
        osc.frequency.value = frequency
        const envelope = b.ctx.createGain()
        envelope.gain.setValueAtTime(0, t)
        envelope.gain.linearRampToValueAtTime(0.3, t + 0.01)
        envelope.gain.exponentialRampToValueAtTime(0.001, t + 0.45)
        osc.connect(envelope)
        envelope.connect(b.mix)
        osc.onended = () => { osc.disconnect(); envelope.disconnect() }
        osc.start(t)
        osc.stop(t + 0.5)
      }
    }
  }

  // ── Microphone passthrough ─────────────────
  // The mic is mixed into the main output only — on the monitor you'd hear yourself late.
  // Its noise suppression is done here (Chromium's), so Discord's own can be switched off;
  // Discord's tends to treat sound effects as noise and mute them.
  const mic = { stream: null, source: null, gain: null, meter: null }

  async function startMic({ deviceId, noiseSuppression, volume, onEnded }) {
    stopMic()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        noiseSuppression,
        echoCancellation: false,
        autoGainControl: false
      }
    })
    const b = bus('main')
    mic.stream = stream
    mic.source = b.ctx.createMediaStreamSource(stream)
    mic.gain = b.ctx.createGain()
    mic.gain.gain.value = volume
    mic.meter = b.ctx.createAnalyser()
    mic.meter.fftSize = 2048
    mic.source.connect(mic.gain)
    mic.gain.connect(b.mix)
    mic.gain.connect(mic.meter)
    wake(b)
    const track = stream.getAudioTracks()[0]
    // Unplugged, or taken away by Windows
    track.addEventListener('ended', () => {
      if (mic.stream !== stream) return
      stopMic()
      onEnded?.()
    })
    return track.label
  }

  function stopMic() {
    if (!mic.stream) return
    for (const track of mic.stream.getTracks()) track.stop()
    mic.source.disconnect()
    mic.gain.disconnect()
    Object.assign(mic, { stream: null, source: null, gain: null, meter: null })
  }

  function setMicVolume(gain) {
    if (mic.gain) mic.gain.gain.setTargetAtTime(gain, mic.gain.context.currentTime, 0.015)
  }

  // ── Meters ─────────────────────────────────
  const scratch = new Float32Array(2048)
  function peakDb(analyser) {
    if (!analyser) return -Infinity
    analyser.getFloatTimeDomainData(scratch)
    let peak = 0
    for (const v of scratch) {
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
    }
    return gainToDb(peak)
  }

  // Current peak levels (dBFS): what leaves the main output and the monitor, and the microphone
  function levels() {
    return { output: peakDb(buses.main?.meter), monitor: peakDb(buses.monitor?.meter), mic: peakDb(mic.meter) }
  }

  // ── Loudness ───────────────────────────────
  // ITU-R BS.1770-4 K-weighting for a sample rate: a +4 dB high shelf (the head's effect on
  // sound), then a high-pass around 38 Hz. Two biquads as { b: [b0, b1, b2], a: [a1, a2] }.
  function kWeighting(rate) {
    let f0 = 1681.974450955533, Q = 0.7071752369554196
    let K = Math.tan(Math.PI * f0 / rate)
    const Vh = Math.pow(10, 3.999843853973347 / 20)
    const Vb = Math.pow(Vh, 0.4996667741545416)
    let a0 = 1 + K / Q + K * K
    const shelf = {
      b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
      a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    }
    f0 = 38.13547087602444
    Q = 0.5003270373238773
    K = Math.tan(Math.PI * f0 / rate)
    a0 = 1 + K / Q + K * K
    const highpass = { b: [1, -2, 1], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] }
    return [shelf, highpass]
  }

  // Integrated loudness (LUFS) and sample peak (dBFS) of decoded audio, gated as in BS.1770-4
  // and EBU R128 — the measure streaming services use to even out volume
  function loudnessOf(audio) {
    const rate = audio.sampleRate
    const length = audio.length
    const channels = audio.numberOfChannels
    const hop = Math.round(rate * 0.1) // 400 ms blocks overlapping by 75%, i.e. 100 ms steps
    const segments = Math.max(1, Math.floor(length / hop))
    const energy = new Float64Array(segments)
    // 5.1 audio: no LFE, surrounds count a little more; anything else counts each channel once
    const weights = channels === 6 ? [1, 1, 1, 0, 1.41, 1.41] : new Array(channels).fill(1)
    const [f1, f2] = kWeighting(rate)
    let peak = 0
    for (let c = 0; c < channels; c++) {
      const x = audio.getChannelData(c)
      const w = weights[c]
      // x: input history, y: shelf output (= high-pass input) history, z: high-pass output history
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0
      for (let i = 0; i < length; i++) {
        const s = x[i]
        const a = s < 0 ? -s : s
        if (a > peak) peak = a
        if (!w) continue
        const y = f1.b[0] * s + f1.b[1] * x1 + f1.b[2] * x2 - f1.a[0] * y1 - f1.a[1] * y2
        const z = f2.b[0] * y + f2.b[1] * y1 + f2.b[2] * y2 - f2.a[0] * z1 - f2.a[1] * z2
        x2 = x1; x1 = s
        y2 = y1; y1 = y
        z2 = z1; z1 = z
        const seg = (i / hop) | 0
        if (seg < segments) energy[seg] += w * z * z
      }
    }

    const blocks = []
    if (segments >= 4) {
      for (let k = 0; k + 4 <= segments; k++) blocks.push((energy[k] + energy[k + 1] + energy[k + 2] + energy[k + 3]) / (4 * hop))
    } else {
      // Shorter than one 400 ms block: the whole clip counts as one
      blocks.push(energy.reduce((sum, e) => sum + e, 0) / Math.min(length, segments * hop))
    }
    const loudness = (z) => -0.691 + 10 * Math.log10(z)
    const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length
    const audible = blocks.filter(z => loudness(z) > -70)
    if (!audible.length) return { lufs: -Infinity, peak: gainToDb(peak) }
    const relativeGate = loudness(mean(audible)) - 10
    let lufs = loudness(mean(audible.filter(z => loudness(z) > relativeGate)))
    // A mono clip plays on both speakers, so it sounds as loud as the same audio in stereo
    if (channels === 1) lufs += 10 * Math.log10(2)
    return { lufs, peak: gainToDb(peak) }
  }

  // Longer clips aren't measured (decoding holds the whole clip in memory); they play unlevelled
  const MAX_MEASURE_SECONDS = 600

  // Measures a clip from its file bytes. Decoding resamples to the context's rate; clips over
  // 3 minutes (or of unknown length) are decoded at 32 kHz to keep memory down, which reads
  // about 0.2 LU low at worst.
  async function measure(bytes, durationSeconds) {
    const rate = durationSeconds <= 180 ? 48000 : 32000
    const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes)
    return loudnessOf(decoded)
  }

  // The auto-level adjustment (dB) for a measured clip
  function levelDb({ lufs, peak }) {
    if (!Number.isFinite(lufs)) return 0
    return Math.max(-MAX_CUT_DB, Math.min(TARGET_LUFS - lufs, PEAK_HEADROOM_DB - peak, MAX_BOOST_DB))
  }

  return {
    play, playTestTone, setMaster, setOutput, setOutputVolume,
    startMic, stopMic, setMicVolume, micActive: () => !!mic.stream,
    levels, measure, levelDb, dbToGain, buildLimiter, loudnessOf, MAX_MEASURE_SECONDS
  }
})()
