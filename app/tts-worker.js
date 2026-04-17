// Merlin TTS utility process — runs Kokoro synthesis off the Electron main
// thread so the UI never stalls during phonemization / ONNX inference.
//
// Why a utility process (not a worker_thread):
//   * Electron's utilityProcess.fork() gives us a real OS process with its
//     own V8 isolate — crashes here can't take down the app window.
//   * The kokoro-js + @huggingface/transformers stack pulls in ~40 MB of
//     runtime; isolating it keeps the main-process footprint lean.
//   * DirectML / CoreML backends spin up their own threadpools; running
//     alongside the UI event loop was causing "Not Responding" stalls.
//
// Protocol (messages via process.parentPort):
//   → { type: "init",  cacheDir, device }                     one-shot setup
//   → { type: "synth", reqId, text, voice, device }           start streamed synthesis (one-shot)
//   → { type: "stream-start",  reqId, voice }                 open a live-text streaming session
//   → { type: "stream-append", reqId, text }                  push one complete sentence to the session
//   → { type: "stream-end",    reqId }                        no more text coming; finalize when drained
//   → { type: "abort" }                                       cancel in-flight synth or stream
//   ← { type: "ready" }                                       after init + model load
//   ← { type: "progress", ...HFProgressPayload }              model download / load
//   ← { type: "chunk", reqId, seq, audio: Uint8Array }        one per sentence (WAV)
//   ← { type: "final", reqId, seq?, aborted?, error? }        end of stream
//   ← { type: "error", reqId?, message }                      unrecoverable failure
//
// Concurrency model: exactly one active job (one-shot OR stream) at a time.
// The `_currentToken` identity test is the single point of invalidation —
// starting a new job or receiving 'abort' swaps the token, and any running
// async loop exits on its next iteration when it notices the mismatch.
const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let _tts = null;
let _loading = null;
let _cacheDir = null;
let _device = 'cpu';
// Unique token for the active job — overwritten on new synth/stream-start or
// abort, so the running for-await loop exits by identity check without
// throwing. A single token covers both one-shot and streaming sessions.
let _currentToken = null;
// Streaming session state. Set by stream-start, cleared by stream-end drain
// or abort. Only ever one session at a time — invariant protected by
// _currentToken being swapped on every new job.
let _stream = null;

function post(payload) {
  try { process.parentPort.postMessage(payload); } catch {}
}

async function loadModel(device) {
  if (_tts) return _tts;
  if (_loading) return _loading;
  _loading = (async () => {
    const { env } = await import('@huggingface/transformers');
    if (_cacheDir) {
      env.cacheDir = _cacheDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
    }
    const { KokoroTTS } = await import('kokoro-js');
    // GPU backends fall back to CPU transparently inside onnxruntime when
    // unavailable, but an explicit try/catch on the selected device lets us
    // surface a useful log line and retry with cpu rather than silently
    // running the slow path.
    try {
      _tts = await KokoroTTS.from_pretrained(KOKORO_REPO, {
        dtype: 'q8',
        device,
        progress_callback: (p) => post({ type: 'progress', ...p }),
      });
    } catch (err) {
      if (device !== 'cpu') {
        console.warn(`[tts-worker] ${device} backend failed, falling back to cpu:`, err && err.message);
        _tts = await KokoroTTS.from_pretrained(KOKORO_REPO, {
          dtype: 'q8',
          device: 'cpu',
          progress_callback: (p) => post({ type: 'progress', ...p }),
        });
      } else {
        throw err;
      }
    }
    return _tts;
  })();
  try { return await _loading; }
  finally { _loading = null; }
}

// Invariant enforcer. Call BEFORE any code that swaps `_currentToken`. If
// there's a live streaming session, emit its final+aborted so main.js can
// relay it to the renderer's per-request listener — otherwise that listener
// leaks forever. Safe to call when no session is active.
function retirePriorStream() {
  const s = _stream;
  if (!s) return;
  _stream = null;
  post({ type: 'final', reqId: s.reqId, seq: s.emittedSeq, aborted: true });
}

async function handleSynth(msg) {
  // One-shot synthesis of `text`. main.js sends an 'abort' preamble before
  // 'synth', which already retires any prior session — the call below is
  // belt-and-suspenders so a future caller that forgets the preamble still
  // cleans up correctly.
  retirePriorStream();
  const token = {};
  _currentToken = token;
  const { reqId, text, voice } = msg;
  try {
    const tts = await loadModel(_device);
    if (_currentToken !== token) { post({ type: 'final', reqId, aborted: true }); return; }
    let seq = 0;
    for await (const chunk of tts.stream(text, { voice })) {
      if (_currentToken !== token) { post({ type: 'final', reqId, seq, aborted: true }); return; }
      const wav = new Uint8Array(chunk.audio.toWav());
      post({ type: 'chunk', reqId, seq, audio: wav });
      seq++;
    }
    if (_currentToken === token) _currentToken = null;
    post({ type: 'final', reqId, seq });
  } catch (err) {
    if (_currentToken === token) _currentToken = null;
    post({ type: 'error', reqId, message: String(err && err.message ? err.message : err) });
  }
}

// ── Streaming-text session ──────────────────────────────────────
// Renderer feeds complete sentences as Claude types them, closing the gap
// between "Claude stopped talking" and "Merlin starts speaking" from ~2-3 s
// (wait-for-full-response + kokoro boot) to ~400-700 ms (first sentence
// boundary + one kokoro pass). See the renderer's streaming-speaker session
// in renderer.js for the feeding side.

async function handleStreamStart(msg) {
  // Invalidate any prior job, then open a fresh session bound to a new
  // token. Loading the model before publishing the session is intentional:
  // appends that arrive during model load sit safely in the queue; the drain
  // loop waits for `ready` before pulling.
  retirePriorStream();
  const token = {};
  _currentToken = token;
  const session = {
    reqId: msg.reqId,
    voice: msg.voice || 'bm_george',
    token,
    pending: [],
    ended: false,
    active: false,   // true while the drain loop is synthesising a sentence
    ready: false,    // flips true once the kokoro model is loaded
    emittedSeq: 0,
  };
  _stream = session;
  try {
    await loadModel(_device);
  } catch (err) {
    if (_stream === session && _currentToken === token) {
      post({ type: 'error', reqId: session.reqId, message: String(err && err.message ? err.message : err) });
      _stream = null;
      _currentToken = null;
    }
    return;
  }
  // Guard: a newer job may have superseded us during the await.
  if (_stream !== session || _currentToken !== token) return;
  session.ready = true;
  streamDrain();
}

function handleStreamAppend(msg) {
  const s = _stream;
  if (!s || s.reqId !== msg.reqId || s.token !== _currentToken) return;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text) return;
  s.pending.push(text);
  if (s.ready) streamDrain();
}

function handleStreamEnd(msg) {
  const s = _stream;
  if (!s || s.reqId !== msg.reqId || s.token !== _currentToken) return;
  s.ended = true;
  // If the drain loop has already emptied the queue and exited, streamDrain
  // here will re-enter and emit the final. If it's mid-sentence, the post-
  // loop check picks up `ended` and finalizes naturally.
  if (s.ready) streamDrain();
}

async function streamDrain() {
  const s = _stream;
  if (!s || !s.ready || s.active) return;
  if (s.token !== _currentToken) return;
  s.active = true;
  try {
    while (_stream === s && s.token === _currentToken) {
      if (s.pending.length === 0) break;
      const sentence = s.pending.shift();
      if (!sentence) continue;
      let localSeq = s.emittedSeq;
      try {
        for await (const chunk of _tts.stream(sentence, { voice: s.voice })) {
          if (_stream !== s || s.token !== _currentToken) return;
          const wav = new Uint8Array(chunk.audio.toWav());
          post({ type: 'chunk', reqId: s.reqId, seq: localSeq, audio: wav });
          localSeq++;
        }
      } catch (err) {
        // A per-sentence failure (bad phoneme, transient ONNX issue) must
        // not cancel sentences already playing in the renderer. Log, drop
        // this sentence, and continue draining so the stream stays alive.
        console.warn('[tts-worker] sentence synth failed:', err && err.message);
      }
      s.emittedSeq = localSeq;
    }
    if (_stream === s && s.token === _currentToken && s.ended && s.pending.length === 0) {
      post({ type: 'final', reqId: s.reqId, seq: s.emittedSeq });
      _stream = null;
      _currentToken = null;
    }
  } finally {
    s.active = false;
    // An append may have landed while we held `active`. Reschedule in a
    // microtask so the caller's stack unwinds first — avoids deep recursion
    // on long back-to-back sentence streams.
    if (_stream === s && s.pending.length > 0 && s.token === _currentToken) {
      queueMicrotask(() => streamDrain());
    }
  }
}

process.parentPort.on('message', async (event) => {
  const msg = event && event.data;
  if (!msg || typeof msg.type !== 'string') return;
  try {
    if (msg.type === 'init') {
      _cacheDir = msg.cacheDir || null;
      _device = msg.device || 'cpu';
      await loadModel(_device);
      post({ type: 'ready' });
    } else if (msg.type === 'synth') {
      // Fire-and-forget — handleSynth streams its own chunks + final message.
      handleSynth(msg);
    } else if (msg.type === 'stream-start') {
      handleStreamStart(msg);
    } else if (msg.type === 'stream-append') {
      handleStreamAppend(msg);
    } else if (msg.type === 'stream-end') {
      handleStreamEnd(msg);
    } else if (msg.type === 'abort') {
      // Flip the token first so any running for-await sees the mismatch on
      // its next iteration and exits. Then retire the stream session so its
      // reqId gets a final+aborted (renderer listener cleanup).
      _currentToken = null;
      retirePriorStream();
    }
  } catch (err) {
    post({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
});

process.on('uncaughtException', (err) => {
  try { post({ type: 'error', message: 'uncaught: ' + String(err && err.message ? err.message : err) }); } catch {}
});
