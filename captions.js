(function (root) {
  "use strict";

  function normalizeCues(rows) {
    const seen = new Set();
    const cues = [];
    for (const row of rows || []) {
      const text = String(row.text || "").replace(/\s+/g, " ").trim();
      if (!text || !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.end <= row.start) continue;
      const key = `${row.start}:${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cues.push({ start: row.start, end: row.end, text, words: row.words || [] });
    }
    cues.sort((a, b) => a.start - b.start);
    // Rolling captions can remain visible after the next spoken cue starts.
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i + 1].start > cues[i].start) cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
    }
    return cues;
  }

  function parseJson3(data) {
    const events = (data?.events || []).filter(event => event.segs?.some(seg => seg.utf8?.trim()) && Number.isFinite(event.tStartMs));
    return normalizeCues(events.map((event, index) => {
      const start = event.tStartMs / 1000;
      const end = Number.isFinite(event.dDurationMs) ? start + event.dDurationMs / 1000 : events[index + 1]?.tStartMs / 1000;
      const words = event.segs.some(seg => Number.isFinite(seg.tOffsetMs)) ? event.segs.map(seg => ({
        text: seg.utf8 || "", start: start + (seg.tOffsetMs || 0) / 1000
      })).filter(word => word.text.trim()) : [];
      return { start, end, text: event.segs.map(seg => seg.utf8 || "").join(""), words };
    }));
  }

  function sentenceRange(rows, time, duration) {
    const cues = normalizeCues(rows).filter(cue => cue.start < duration).map(cue => ({ ...cue, end: Math.min(cue.end, duration) }));
    // In a short gap, favor the line just heard rather than the next line.
    let hit = -1;
    for (let i = 0; i < cues.length; i++) {
      if (cues[i].start <= time && time < cues[i].end) hit = i;
    }
    if (hit < 0) {
      for (let i = cues.length - 1; i >= 0; i--) {
        if (cues[i].end <= time && time - cues[i].end <= 1.5) { hit = i; break; }
      }
    }
    if (hit < 0) return null;

    let left = hit;
    let right = hit;
    while (left > 0 && cues[left].start - cues[left - 1].end < 1.2) left--;
    while (right + 1 < cues.length && cues[right + 1].start - cues[right].end < 1.2) right++;
    let text = "";
    const units = [];
    for (let index = left; index <= right; index++) {
      const cue = cues[index];
      const words = cue.words.filter(word => word.text?.trim() && Number.isFinite(word.start) && word.start >= cue.start && word.start < cue.end);
      const parts = words.length ? words : [{ text: cue.text, start: cue.start }];
      for (let j = 0; j < parts.length; j++) {
        const value = parts[j].text.trim();
        if (text) text += " ";
        units.push({ index, offset: text.length, limit: text.length + value.length, start: parts[j].start, end: parts[j + 1]?.start || cue.end });
        text += value;
      }
    }
    const hitUnits = units.filter(unit => unit.index === hit);
    const anchor = [...hitUnits].reverse().find(unit => unit.start <= time) || hitUnits[0];
    for (const sentence of new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)) {
      const limit = sentence.index + sentence.segment.length;
      if (anchor.offset >= limit || anchor.limit <= sentence.index) continue;
      const included = units.filter(unit => unit.offset < limit && unit.limit > sentence.index);
      const start = included[0].start;
      const end = included[included.length - 1].end;
      const punctuated = /[.!?。！？][\s"'’”\])}]*$/.test(sentence.segment.trim());
      if (end > start && end - start <= 40 && punctuated) return { start, end, text: sentence.segment.trim(), boundary: "sentence" };
      if (end > start && end - start <= 30 && (right < cues.length - 1 || duration - end <= 1)) {
        return { start, end, text: sentence.segment.trim(), boundary: "pause" };
      }
      break;
    }
    // No reliable sentence ending: do not loop an arbitrarily long transcript.
    const cue = cues[hit];
    if (cue.end - cue.start > 40) return null;
    return { start: cue.start, end: cue.end, text: cue.text, boundary: "cue" };
  }

  const api = { normalizeCues, parseJson3, sentenceRange };
  root.EngBookmarkCaptions = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
