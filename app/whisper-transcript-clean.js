// Whisper transcript sanitizer — strips decoder artifacts and the
// well-known subtitle-watermark hallucinations that ggml-small.en-q5_1
// (and tiny.en before it) emit when the audio is silence, near-silence,
// or low-SNR.
//
// Background: Whisper's training set includes a large amount of YouTube
// closed captions and fan-sub files. When the decoder has nothing
// meaningful to transcribe, its language model falls back to the most
// common "end of an audio clip" strings it saw during training — the
// subtitle credit lines. Users experience this as phantom text appearing
// in the chat that they never spoke ("Subs by www.zeoranger.co.uk",
// "Thanks for watching!", "Please subscribe"). This is not our audio
// pipeline corrupting anything — it is the model hallucinating against
// silence. The only fix is to filter these lines out after the decode.
//
// The filter is conservative: it matches subtitle-CREDIT lines (which
// have a stable shape: "<verb> by <attribution>") and a small set of
// exact-match known hallucinations. A brand ad user will essentially
// never utter these phrases, so the false-positive risk is negligible.
// If we're ever wrong, the user just re-records — which is strictly
// better than silently injecting "Subs by <sketchy URL>" into a prompt
// that a paying customer then reads in their chat history.
//
// Dual-module shim so the renderer / main / tests can all require it.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MerlinWhisperClean = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // whisper-cli's own diagnostic lines. These never represent user speech.
  //   "[BLANK_AUDIO]"        — VAD fallback tag
  //   "[SOUND]", "[MUSIC]"   — non-speech tags
  //   "whisper_init_from_..."/"whisper_print_timings" — library logs
  // Matched by prefix, line-anchored.
  function isWhisperDiagnosticLine(line) {
    if (!line) return true;
    if (line.startsWith('[') && line.endsWith(']')) return true;
    if (line.startsWith('whisper_')) return true;
    return false;
  }

  // Subtitle-credit shapes. These are the Whisper hallucinations in the
  // wild — "<verb> by <attrib>" or "<noun>: <attrib>" with a small set of
  // verbs/nouns that only appear in fan-sub / YouTube caption credits.
  //
  // Intentionally case-insensitive and tolerant of trailing periods /
  // exclamation marks — the exact punctuation varies across training
  // samples.
  const SUBTITLE_CREDIT_RES = [
    // "Subs by www.zeoranger.co.uk" / "Subtitles by the Amara.org community"
    /^\s*(subs|subtitles|captions|caption|subtitle|cc|transcript|transcription)\s+(by|from|:)\b.*$/i,
    // "Transcribed by X" / "Translated by Y"
    /^\s*(transcribed|translated|synced|corrected|edited|timed|typeset)\s+by\b.*$/i,
    // "Subtitling: X" / "Subtitles: X"
    /^\s*(subtitling|subtitles?|captioning|captions?)\s*[:\-–—]\s*\S.*$/i,
    // "www.zeoranger.co.uk" standalone (known hallucination — ships bare
    // sometimes when the language model trails off).
    /^\s*(www\.)?zeoranger\.co\.uk\s*\.?\s*$/i,
    // "Amara.org community" standalone
    /^\s*(the\s+)?amara\.org(\s+community)?\s*\.?\s*$/i,
  ];

  // Exact-match (normalized: lowercased, trimmed, trailing punctuation
  // stripped) hallucinations. Collected from whisper.cpp issue threads and
  // our own Merlin field reports on ggml-small.en-q5_1 + ggml-tiny.en.
  const EXACT_HALLUCINATIONS = new Set([
    'thanks for watching',
    'thank you for watching',
    'thanks for watching!',
    'thank you for watching!',
    'thanks for watching the video',
    'please subscribe',
    'please subscribe to my channel',
    'please like and subscribe',
    'like and subscribe',
    'like, comment, and subscribe',
    "don't forget to subscribe",
    'see you in the next video',
    'see you next time',
    'see you next week',
    'bye bye',
    'bye-bye',
    'peace',
    'peace out',
    // Music-intro artifacts
    '(music)',
    '[music]',
    '(music playing)',
    '[music playing]',
    '(upbeat music)',
    '[upbeat music]',
    // Common non-English closers tiny.en hallucinates on silence
    'ご視聴ありがとうございました',
    'ご視聴ありがとうございました。',
    '다음 시간에 뵙겠습니다',
    'gracias por ver',
    'gracias por ver el video',
  ]);

  // Normalize for exact-match lookup: lowercase, collapse whitespace,
  // strip trailing punctuation/quotes. Keeps internal punctuation so
  // "(music)" still matches "(Music)".
  function normalizeForExactMatch(line) {
    return line
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/^[\s"'`]+|[\s"'`.!?,;:·•…]+$/g, '')
      .trim();
  }

  function isKnownHallucinationLine(line) {
    if (!line) return false;
    const normalized = normalizeForExactMatch(line);
    if (!normalized) return false;
    if (EXACT_HALLUCINATIONS.has(normalized)) return true;
    for (const re of SUBTITLE_CREDIT_RES) {
      if (re.test(line)) return true;
    }
    return false;
  }

  // Clean a whisper-cli stdout transcript. Splits on newlines, drops
  // diagnostic lines + subtitle-credit hallucinations, re-joins with a
  // single space. Returns an empty string if everything was filtered —
  // upstream treats that as "no speech detected" and shows the empty
  // recording coach message instead of piping the watermark into chat.
  function cleanWhisperTranscript(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    const kept = [];
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (isWhisperDiagnosticLine(line)) continue;
      if (isKnownHallucinationLine(line)) continue;
      kept.push(line);
    }
    return kept.join(' ').replace(/\s+/g, ' ').trim();
  }

  return {
    cleanWhisperTranscript,
    isKnownHallucinationLine,
    isWhisperDiagnosticLine,
    normalizeForExactMatch,
  };
}));
