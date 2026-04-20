'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanWhisperTranscript, isKnownHallucinationLine } = require('./whisper-transcript-clean.js');

// ── Subtitle-watermark hallucinations (the reported incident) ──

test('strips "Subs by www.zeoranger.co.uk" from a single-line transcript', () => {
  assert.equal(cleanWhisperTranscript('Subs by www.zeoranger.co.uk'), '');
});

test('strips the watermark when it trails real speech on its own line', () => {
  const raw = 'Can you pull the Meta ROAS for last week?\nSubs by www.zeoranger.co.uk';
  assert.equal(cleanWhisperTranscript(raw), 'Can you pull the Meta ROAS for last week?');
});

test('strips Subtitles-by / Captions-by variants', () => {
  for (const line of [
    'Subtitles by www.zeoranger.co.uk',
    'Subtitles by the Amara.org community',
    'Captions by CaptionSync',
    'Subtitle by anonymous',
    'CC by SubRip',
    'Transcript by OtherSite',
  ]) {
    assert.equal(cleanWhisperTranscript(line), '', `expected filter to strip: ${line}`);
  }
});

test('strips bare "www.zeoranger.co.uk" and "Amara.org community"', () => {
  assert.equal(cleanWhisperTranscript('www.zeoranger.co.uk'), '');
  assert.equal(cleanWhisperTranscript('zeoranger.co.uk.'), '');
  assert.equal(cleanWhisperTranscript('Amara.org community'), '');
  assert.equal(cleanWhisperTranscript('the Amara.org community.'), '');
});

test('strips "Transcribed by" / "Translated by" credit lines', () => {
  assert.equal(cleanWhisperTranscript('Transcribed by ESO; translated by —'), '');
  assert.equal(cleanWhisperTranscript('Translated by GoogleTranslate'), '');
  assert.equal(cleanWhisperTranscript('Synced by elderman'), '');
});

test('strips "Subtitling: X" colon form', () => {
  assert.equal(cleanWhisperTranscript('Subtitling: Acme Captions'), '');
  assert.equal(cleanWhisperTranscript('Subtitles: Amara'), '');
});

// ── Exact-match hallucinations ──

test('strips "Thanks for watching!" family', () => {
  for (const line of [
    'Thanks for watching!',
    'Thank you for watching.',
    'Thanks for watching',
    'THANKS FOR WATCHING!!!',
    'Thanks for watching the video',
  ]) {
    assert.equal(cleanWhisperTranscript(line), '', `expected filter to strip: ${line}`);
  }
});

test('strips subscribe-pitch hallucinations', () => {
  for (const line of [
    'Please subscribe',
    'Please subscribe to my channel',
    'Like and subscribe',
    "Don't forget to subscribe",
    'See you in the next video',
  ]) {
    assert.equal(cleanWhisperTranscript(line), '', `expected filter to strip: ${line}`);
  }
});

test('strips non-English closers tiny.en hallucinates on silence', () => {
  assert.equal(cleanWhisperTranscript('ご視聴ありがとうございました'), '');
  assert.equal(cleanWhisperTranscript('gracias por ver'), '');
});

test('strips music-cue brackets emitted on low-SNR audio', () => {
  for (const line of ['(Music)', '[Music]', '(upbeat music)', '[Music Playing]']) {
    assert.equal(cleanWhisperTranscript(line), '', `expected filter to strip: ${line}`);
  }
});

// ── Whisper diagnostic lines ──

test('strips [BLANK_AUDIO] and other bracketed diagnostic tags', () => {
  assert.equal(cleanWhisperTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanWhisperTranscript('[SOUND]\n[MUSIC]'), '');
});

test('strips whisper_* library log lines', () => {
  assert.equal(cleanWhisperTranscript('whisper_init_from_file_no_state: loading model'), '');
  assert.equal(cleanWhisperTranscript('whisper_print_timings:   load time =   300.00 ms'), '');
});

// ── False-positive guards ──

test('keeps normal dictation that happens to contain "subscribe"', () => {
  const raw = 'Can you draft an email telling customers to subscribe to the newsletter?';
  assert.equal(cleanWhisperTranscript(raw), raw);
});

test('keeps normal dictation that happens to contain "thanks"', () => {
  const raw = 'Send a thank-you note thanking them for their business.';
  assert.equal(cleanWhisperTranscript(raw), raw);
});

test('keeps "written by" / "made by" — only subtitle verbs are filtered', () => {
  assert.equal(
    cleanWhisperTranscript('The blog post was written by our in-house copywriter.'),
    'The blog post was written by our in-house copywriter.'
  );
});

test('keeps real speech mentioning URLs that look like credits', () => {
  const raw = 'Our landing page lives at merlingotme.com.';
  assert.equal(cleanWhisperTranscript(raw), raw);
});

test('keeps the URL when it appears mid-sentence (not alone)', () => {
  // The filter is line-oriented; a URL inline with real speech stays.
  const raw = 'Check www.zeoranger.co.uk for the brief.';
  // Not a known hallucination because it's a real sentence — keep it.
  assert.equal(isKnownHallucinationLine(raw), false);
});

// ── Edge cases ──

test('empty / null / non-string input returns empty string', () => {
  assert.equal(cleanWhisperTranscript(''), '');
  assert.equal(cleanWhisperTranscript(null), '');
  assert.equal(cleanWhisperTranscript(undefined), '');
  assert.equal(cleanWhisperTranscript(42), '');
});

test('pure whitespace / punctuation noise returns empty string', () => {
  assert.equal(cleanWhisperTranscript('   \n\n  \n'), '');
});

test('mixed diagnostic + hallucination + real speech yields only real speech', () => {
  const raw = [
    '[BLANK_AUDIO]',
    'whisper_init_from_file_no_state: loading model',
    'Please push the Meta creative to the scaling ad set.',
    'Thanks for watching!',
    'Subs by www.zeoranger.co.uk',
  ].join('\n');
  assert.equal(cleanWhisperTranscript(raw), 'Please push the Meta creative to the scaling ad set.');
});

test('collapses internal double-spaces after joining surviving lines', () => {
  const raw = 'First sentence.\nSecond sentence.';
  assert.equal(cleanWhisperTranscript(raw), 'First sentence. Second sentence.');
});
