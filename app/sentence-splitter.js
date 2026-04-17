// Streaming sentence extractor for the live-TTS pipeline.
//
// Called on every Claude text delta with the accumulated `cleaned` text and
// the index already consumed. Returns any newly-complete sentences plus the
// updated consumed index. Incomplete tails are preserved — the caller passes
// the same `cleaned` text on the next call, and we resume from `nextIdx`.
//
// Design notes:
//   * Sentence boundary = terminal punctuation ([.!?]) followed by whitespace,
//     or a blank-line paragraph break (\n\n+). We don't use end-of-string as
//     a boundary because Claude's next token may extend the current sentence.
//   * A "sentence" shorter than MIN_SENTENCE_CHARS is coalesced with the next
//     one. Short fragments ("Hi.", "1.", "Go!") produce ~200 ms of Kokoro
//     overhead per fragment for ~300 ms of audio, which is wasted work and
//     sounds choppy. Pairing them halves the overhead without hurting latency
//     on normal prose (first substantial sentence is always ≥ 12 chars).
//   * No lookbehind — keeps this runnable in every browser Electron ships
//     with, and simpler regex is easier to reason about.
//
// Dual-module shim: loaded as a global (window.MerlinSentenceSplitter) in the
// renderer, and as a CommonJS module in the node-based test harness. Keep
// both export paths intact when editing.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MerlinSentenceSplitter = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  // Consume the trailing whitespace as part of the match so the next scan
  // resumes cleanly at the start of the next sentence instead of having to
  // re-swallow a stray leading space every call.
  const SENTENCE_END_RE = /[.!?]\s+|\n\n+/g;
  const MIN_SENTENCE_CHARS = 12;

  // Extract every complete sentence that has appeared in `cleaned` since
  // `fromIdx`. Returns:
  //   sentences: string[]   — ready to hand to Kokoro, in order
  //   nextIdx:   number     — updated consumed index for the next call
  //
  // Invariant: on every call, the caller passes the same consumed prefix of
  // `cleaned` that it passed last time plus any new content. The function is
  // stateless across calls — all state lives in `fromIdx`.
  function extractCompleteSentences(cleaned, fromIdx) {
    if (typeof cleaned !== 'string') return { sentences: [], nextIdx: fromIdx | 0 };
    const start = Math.max(0, Math.min(fromIdx | 0, cleaned.length));
    const tail = cleaned.slice(start);
    const out = [];
    let buf = '';
    let lastFlushEnd = 0;
    let cursor = 0;
    SENTENCE_END_RE.lastIndex = 0;
    let m;
    while ((m = SENTENCE_END_RE.exec(tail)) !== null) {
      const endAt = m.index + m[0].length;
      buf += tail.slice(cursor, endAt);
      cursor = endAt;
      const trimmed = buf.trim();
      if (trimmed.length >= MIN_SENTENCE_CHARS) {
        out.push(trimmed);
        buf = '';
        lastFlushEnd = cursor;
      }
      // else: keep accumulating. cursor advances but lastFlushEnd does not,
      // so the partial group is re-scanned on the next call with more text.
    }
    return { sentences: out, nextIdx: start + lastFlushEnd };
  }

  // Flush whatever is left — called at end-of-stream. Ignores the length
  // minimum because no more text will ever arrive to pair with it.
  function drainRemaining(cleaned, fromIdx) {
    if (typeof cleaned !== 'string') return '';
    const start = Math.max(0, Math.min(fromIdx | 0, cleaned.length));
    const rest = cleaned.slice(start).trim();
    return rest || '';
  }

  return { extractCompleteSentences, drainRemaining, MIN_SENTENCE_CHARS };
}));
