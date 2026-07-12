// Server-side block anchoring — the heart of decision #1.
//
// Anchoring a comment to a span of generated HTML is the PRD's single biggest
// technical risk. The old prototype hashed block text on the client and
// disambiguated identical blocks by *occurrence order*, so inserting a
// duplicate block silently shifted every later comment onto the wrong block.
//
// This module fixes that by assigning block ids on the SERVER and carrying them
// across re-publishes by matching the new version's blocks against the previous
// version's blocks (exact text → fuzzy text → empty-by-tag → fresh id). Ids are identity, not
// position: inserting a duplicate block consumes no existing match, so it gets a
// brand-new id and never steals a comment. Pure + dependency-free so it can be
// unit-tested in isolation.

// Block-level elements a comment can anchor to. Beyond the classic prose tags,
// agent-generated HTML (dashboards, cards, Tailwind-style layouts) very often
// puts standalone text straight in a <div>/<section> with no <p>/<li> wrapper at
// all — that text got no data-block-id and was silently "not commentable" from
// the viewer. Generic containers are included so any standalone text has SOME
// anchorable ancestor; deliberately excludes purely inline tags (span, a, b, em,
// strong, ...) since those normally sit inside an already-anchorable block and
// including them would fragment one paragraph into several disconnected blocks.
const BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'pre', 'figcaption', 'td', 'th',
  'div', 'section', 'article', 'header', 'footer', 'aside', 'dt', 'dd', 'summary', 'details', 'address', 'caption',
]);

// Carry a comment's id forward only when the block is clearly still the same.
const MATCH_THRESHOLD = 0.7;
// Re-anchor a comment's *display* to a similar block before giving up to orphan.
const RESOLVE_THRESHOLD = 0.5;
// Short blocks (a heading, a label, a table cell) are where Sørensen–Dice is
// least reliable: adding one word ("ROI" → "Net ROI") tanks the score and
// orphans a legitimate edit. For blocks at/under this token count we also accept
// a whole-text token-containment match. Bounded so a short snippet can't latch
// onto an unrelated long paragraph that merely mentions the same word.
const SHORT_BLOCK_MAX_TOKENS = 4;
// A fuzzy carry must rest on a real shared vocabulary, not a couple of repeated
// low-entropy bigrams. Require at least this many DISTINCT shared bigrams before
// trusting a fuzzy (non-containment) match.
const MIN_SHARED_BIGRAMS = 3;

// --- text normalisation ---
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : m;
    }
    return e in ENTITIES ? ENTITIES[e] : m;
  });
}
export function norm(s) {
  return decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim().toLowerCase();
}

// --- similarity (Sørensen–Dice over DISTINCT character bigrams) ---
// Distinct (set-based) rather than multiplicity-weighted: repeated text like
// "ab ab ab ab" otherwise inflates the bigram overlap and lets unrelated
// low-entropy blocks score spuriously high. We also surface the count of shared
// distinct bigrams so callers can refuse a match that rests on too thin an
// overlap (see MIN_SHARED_BIGRAMS / anchorSim).
function bigramSet(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
function diceStats(a, b) {
  if (a === b) return { score: a ? 1 : 0, shared: a ? bigramSet(a).size : 0 };
  if (!a || !b || a.length < 2 || b.length < 2) return { score: 0, shared: 0 };
  const A = bigramSet(a), B = bigramSet(b);
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  const denom = A.size + B.size;
  return { score: denom ? (2 * shared) / denom : 0, shared };
}
export function similarity(a, b) {
  return diceStats(a, b).score;
}

// --- block matching score: Dice + short-block containment + a thin-overlap floor ---
// Used wherever we decide whether two blocks are "the same" (reconcile's fuzzy
// pass and resolveAnchor's re-anchor). Distinct from raw similarity() so the
// latter stays a pure metric.
function tokensOf(s) { return s ? s.split(' ') : []; }
function isContiguousSubseq(small, big) {
  if (!small.length || small.length > big.length) return false;
  for (let i = 0; i + small.length <= big.length; i++) {
    let ok = true;
    for (let k = 0; k < small.length; k++) if (big[i + k] !== small[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}
// True when the shorter block's whole text is a contiguous run of whole tokens
// inside the longer, and the longer is itself short. Symmetric, so it catches
// both a small addition ("ROI" → "Net ROI") and the matching removal.
function shortContains(a, b) {
  const ta = tokensOf(a), tb = tokensOf(b);
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (!small.length || big.length > SHORT_BLOCK_MAX_TOKENS) return false;
  return isContiguousSubseq(small, big);
}
export function anchorSim(a, b) {
  if (shortContains(a, b)) return 1;
  const { score, shared } = diceStats(a, b);
  if (shared < MIN_SHARED_BIGRAMS) return 0; // too little distinct overlap to trust
  return score;
}

// --- lossless tokeniser (concatenating the tokens reproduces the input) ---
const TOKEN_RE = /<!--[\s\S]*?-->|<[a-zA-Z/!?][^>]*>|[^<]+|</g;
export function tokenize(html) {
  return String(html || '').match(TOKEN_RE) || [];
}
function tagInfo(tok) {
  if (tok[0] !== '<' || tok[1] === '!' || tok[1] === '?') return null;
  const m = tok.match(/^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/);
  if (!m) return null;
  return { close: m[1] === '/', name: m[2].toLowerCase(), selfClose: /\/>\s*$/.test(tok) };
}

// Walk the tokens, attributing text to the *innermost* open block (matching how
// the viewer maps a selection to el.closest('[data-block-id]')).
export function scanBlocks(tokens) {
  const blocks = [];
  const stack = [];
  tokens.forEach((tok, i) => {
    if (tok[0] === '<') {
      const info = tagInfo(tok);
      if (!info) return; // comment / doctype / stray '<'
      if (info.close) {
        if (BLOCK_TAGS.has(info.name)) {
          for (let k = stack.length - 1; k >= 0; k--) {
            if (blocks[stack[k]].tag === info.name) { stack.length = k; break; }
          }
        }
      } else if (BLOCK_TAGS.has(info.name) && !info.selfClose) {
        // Implicit close for optional-end-tag elements, matching the browser's DOM:
        // a <p> is closed by any block start; an <li> by another <li>; a <td>/<th>
        // by the next cell. Without this, "<li>a<li>b</li>" leaves a block dangling
        // on the stack and mis-attributes later text.
        while (stack.length) {
          const top = blocks[stack[stack.length - 1]].tag;
          const closes = top === 'p'
            || (top === 'li' && info.name === 'li')
            || ((top === 'td' || top === 'th') && (info.name === 'td' || info.name === 'th'));
          if (closes) stack.pop(); else break;
        }
        const idx = blocks.length;
        blocks.push({ tag: info.name, text: '', openIdx: i });
        stack.push(idx);
      }
    } else if (stack.length) {
      blocks[stack[stack.length - 1]].text += tok;
    }
  });
  return blocks;
}

// --- id injection ---
function injectAttr(tagStr, id) {
  const s = tagStr.replace(/\s+data-block-id="[^"]*"/g, '');
  return s.replace(/^(<[a-zA-Z][a-zA-Z0-9]*)/, (m, p1) => `${p1} data-block-id="${id}"`);
}
function injectIds(tokens, blocks, ids) {
  const out = tokens.slice();
  blocks.forEach((b, i) => { out[b.openIdx] = injectAttr(out[b.openIdx], ids[i]); });
  return out.join('');
}

// --- reconciliation: assign ids to the new version's blocks, carrying ids
//     forward from the previous version. THIS is the ordinal-collision fix. ---
export function reconcile(prevBlocks, newBlocks, startNum) {
  prevBlocks = prevBlocks || [];
  // Accept either the rich {t, tag} shape or a plain string[] of normalized text
  // (legacy callers / direct tests), normalizing to objects internally.
  const news = (newBlocks || []).map((b) => (typeof b === 'string' ? { t: b, tag: null } : { t: b.t || '', tag: b.tag || null }));
  const N = news.length;
  const used = new Array(prevBlocks.length).fill(false);
  const ids = new Array(N).fill(null);

  // Pass 1 — exact text match, preferring the positionally nearest unused block
  // (so "insert a duplicate at the top" keeps each comment on the closest twin).
  for (let i = 0; i < N; i++) {
    const t = news[i].t;
    if (!t) continue;
    let best = -1, bestDist = Infinity;
    for (let j = 0; j < prevBlocks.length; j++) {
      if (used[j] || prevBlocks[j].t !== t) continue;
      const d = Math.abs(j - i);
      if (d < bestDist) { bestDist = d; best = j; }
    }
    if (best >= 0) { ids[i] = prevBlocks[best].id; used[best] = true; }
  }

  // Pass 2 — fuzzy match the leftovers (a block whose text was lightly edited).
  // anchorSim folds in short-block containment and the thin-overlap floor.
  for (let i = 0; i < N; i++) {
    if (ids[i] !== null) continue;
    const t = news[i].t;
    if (!t) continue;
    let best = -1, bestSim = MATCH_THRESHOLD, bestDist = Infinity;
    for (let j = 0; j < prevBlocks.length; j++) {
      if (used[j]) continue;
      const s = anchorSim(t, prevBlocks[j].t);
      const d = Math.abs(j - i);
      if (s > bestSim || (s === bestSim && d < bestDist)) { bestSim = s; best = j; bestDist = d; }
    }
    if (best >= 0) { ids[i] = prevBlocks[best].id; used[best] = true; }
  }

  // Pass 3 — empty-text blocks (e.g. <td></td>) have no text to hash, so passes
  // 1–2 skip them and they'd mint a fresh id (burning a block number) on every
  // republish. Keep their id stable by matching an unused empty-text prev block
  // of the SAME tag, nearest by position.
  for (let i = 0; i < N; i++) {
    if (ids[i] !== null || news[i].t) continue;
    let best = -1, bestDist = Infinity;
    for (let j = 0; j < prevBlocks.length; j++) {
      if (used[j] || prevBlocks[j].t) continue;                    // prev must also be empty-text
      if ((prevBlocks[j].tag || null) !== news[i].tag) continue;   // and the same tag
      const d = Math.abs(j - i);
      if (d < bestDist) { bestDist = d; best = j; }
    }
    if (best >= 0) { ids[i] = prevBlocks[best].id; used[best] = true; }
  }

  // Pass 4 — anything still unmatched is genuinely new: mint a fresh id.
  let n = startNum || 1;
  for (let i = 0; i < N; i++) {
    if (ids[i] === null) ids[i] = 'b' + (n++);
  }
  return { ids, nextBlockNum: n };
}

// Process one publish: tokenize, scan blocks, reconcile ids against the previous
// version, inject data-block-id into the markup, and return everything the store
// needs to persist.
export function processPublish(prevBlocks, html, startNum) {
  const tokens = tokenize(html);
  const rawBlocks = scanBlocks(tokens);
  const newBlocks = rawBlocks.map((b) => ({ t: norm(b.text), tag: b.tag }));
  const { ids, nextBlockNum } = reconcile(prevBlocks, newBlocks, startNum);
  const processed = injectIds(tokens, rawBlocks, ids);
  // Persist the tag alongside id+text so empty-text blocks can be re-matched by
  // tag+position on the next republish (reconcile pass 3).
  const blocks = ids.map((id, i) => ({ id, t: newBlocks[i].t, tag: newBlocks[i].tag }));
  return { html: processed, blocks, nextBlockNum };
}

// Resolve where a comment should display in the *current* version.
//
//   id still present AND its text is UNCHANGED since the comment → solid anchor
//   id still present but its text was EDITED                     → soft (moved/edited)
//   id gone, but a similar block exists                          → soft (moved/edited)
//   nothing similar                                             → orphan (block_id: null)
//
// The crucial subtlety: reconcile() carries an id forward across a fuzzy (>=0.7)
// edit for threading/layout, so "id present" does NOT imply "content unchanged".
// We must re-compare the block's CURRENT text against the snapshot taken when the
// comment was made — otherwise a flipped number or an inserted "not" would render
// as a confident solid anchor on changed (sometimes reversed) content. Orphaning
// or a visible "edited" badge is acceptable; a silent wrong anchor is not.
export function resolveAnchor(anchor, currentBlocks) {
  currentBlocks = currentBlocks || [];
  const aid = anchor && (anchor.block_id || anchor.block_mid);
  // block_fingerprint is the server's authoritative normalized text at comment time;
  // fall back to the (possibly truncated) client block_text snapshot.
  const snap = anchor ? (anchor.block_fingerprint || norm(anchor.block_text || '')) : '';
  const cur = aid ? currentBlocks.find((b) => b.id === aid) : null;
  if (cur) {
    if (!snap || snap === cur.t) return { block_id: aid, soft: false }; // unchanged (or nothing to verify) → solid
    return { block_id: aid, soft: true, edited: true }; // same block, but its text changed → visible
  }
  if (snap) {
    let best = null, bestSim = RESOLVE_THRESHOLD;
    for (const b of currentBlocks) {
      const s = anchorSim(snap, b.t);
      if (s > bestSim) { bestSim = s; best = b; }
    }
    if (best) return { block_id: best.id, soft: true, sim: Math.round(bestSim * 100) / 100 };
  }
  return { block_id: null };
}
