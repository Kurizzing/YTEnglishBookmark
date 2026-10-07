const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCues, parseJson3, sentenceRange } = require("../captions.js");

test("parse json3 captions into cue and word timing", () => {
  const cues = parseJson3({ events: [
    { tStartMs: 1000, dDurationMs: 900, segs: [{ utf8: "Hello " }, { utf8: "there.", tOffsetMs: 300 }] },
    { tStartMs: 2100, dDurationMs: 800, segs: [{ utf8: "How are you?" }] }
  ] });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "Hello there.");
  assert.equal(cues[0].words[1].start, 1.3);
  assert.equal(cues[0].end, 1.9);
});

test("find the complete sentence containing a slightly late bookmark", () => {
  const cues = normalizeCues([
    { start: 10, end: 11, text: "I wanted to" },
    { start: 11.05, end: 12.4, text: "ask you something." },
    { start: 13.9, end: 15, text: "Are you free?" }
  ]);
  assert.deepEqual(sentenceRange(cues, 12.2, 30), { start: 10, end: 12.4, text: "I wanted to ask you something.", boundary: "sentence" });
  assert.deepEqual(sentenceRange(cues, 14.2, 30), { start: 13.9, end: 15, text: "Are you free?", boundary: "sentence" });
});

test("fallback to one cue for auto-caption lines without punctuation and reject invalid/long cues", () => {
  const cues = [
    { start: 2, end: 4, text: "an automatically generated line" },
    { start: 8, end: 55, text: "too long" }
  ];
  assert.deepEqual(sentenceRange(cues, 3, 60), { start: 2, end: 4, text: "an automatically generated line", boundary: "pause" });
  assert.equal(sentenceRange(cues, 20, 60), null);
  assert.deepEqual(normalizeCues([{ start: 1, end: 1, text: "empty" }, { start: -1, end: 2, text: "bad" }, { start: 2, end: 3, text: "ok" }]), [{ start: 2, end: 3, text: "ok", words: [] }]);
});
