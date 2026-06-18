// Unit tests for the anchoring engine (server/blocks.js).
// Run: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, scanBlocks, reconcile, processPublish, resolveAnchor, norm, similarity, anchorSim } from '../server/blocks.js';

// Simulate the store's publish loop: thread currentBlocks + nextBlockNum forward.
function publishSeq(htmls) {
  let prev = [], next = 1;
  const versions = [];
  for (const h of htmls) {
    const r = processPublish(prev, h, next);
    prev = r.blocks; next = r.nextBlockNum;
    versions.push(r);
  }
  return { versions, final: prev };
}
const byId = (blocks, id) => blocks.find((b) => b.id === id);

test('tokenize is lossless', () => {
  for (const html of [
    '<p>hello</p>',
    '<div><h1>Hi</h1><p>Body &amp; more</p></div>',
    '<!-- c --><p>x</p>\n<ul><li>a</li><li>b</li></ul>',
    'a < b and c > d <p>ok</p>',
  ]) {
    assert.equal(tokenize(html).join(''), html, html);
  }
});

test('scanBlocks attributes text to the innermost block', () => {
  const blocks = scanBlocks(tokenize('<blockquote>Intro <p>nested</p> tail</blockquote><p>after</p>'));
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].tag, 'blockquote');
  assert.equal(norm(blocks[0].text), 'intro tail');
  assert.equal(norm(blocks[1].text), 'nested');
  assert.equal(norm(blocks[2].text), 'after');
});

test('scanBlocks handles optional-end-tag HTML (implicit close)', () => {
  const blocks = scanBlocks(tokenize('<ul><li>a<li>b</li></ul><p>x<p>y</p>'));
  assert.deepEqual(blocks.map((b) => norm(b.text)), ['a', 'b', 'x', 'y']);
});

test('processPublish injects ids and preserves visible text', () => {
  const r = processPublish([], '<h1>Title</h1><p class="x">Body</p>', 1);
  assert.match(r.html, /<h1 data-block-id="b1">Title<\/h1>/);
  assert.match(r.html, /<p data-block-id="b2" class="x">Body<\/p>/);
  assert.deepEqual(r.blocks.map((b) => b.id), ['b1', 'b2']);
  assert.equal(r.nextBlockNum, 3);
});

test('no change → ids are stable across republish', () => {
  const html = '<p>Alpha</p><p>Beta</p><p>Gamma</p>';
  const { versions } = publishSeq([html, html]);
  assert.deepEqual(versions[0].blocks.map((b) => b.id), versions[1].blocks.map((b) => b.id));
});

test('THE ordinal-collision fix: inserting a duplicate never moves a comment to different content', () => {
  // v1: a Revenue heading + paragraph, a Costs heading + paragraph.
  const v1 = '<h2>Revenue</h2><p>Revenue up 18 percent</p><h2>Costs</h2><p>Costs up 40 percent</p>';
  const r1 = processPublish([], v1, 1);
  const revPara = r1.blocks[1];   // the paragraph the human comments on
  const costPara = r1.blocks[3];
  assert.equal(norm('Revenue up 18 percent'), revPara.t);
  const comment = { anchor: { block_id: revPara.id, block_text: 'Revenue up 18 percent', quote: '18 percent' } };

  // v2: a SECOND "Revenue" heading is inserted at the very top (the classic trap:
  // an identical block appears before the commented region).
  const v2 = '<h2>Revenue</h2><h2>Revenue</h2><p>Revenue up 18 percent</p><h2>Costs</h2><p>Costs up 40 percent</p>';
  const r2 = processPublish(r1.blocks, v2, r1.nextBlockNum);

  const resolved = resolveAnchor(comment.anchor, r2.blocks);
  // It must still resolve, solidly, to a block whose text is the revenue paragraph —
  // never the costs paragraph, never a Revenue heading.
  assert.equal(resolved.block_id, revPara.id);
  assert.equal(byId(r2.blocks, resolved.block_id).t, norm('Revenue up 18 percent'));
  // And the costs paragraph keeps its own identity untouched.
  assert.ok(byId(r2.blocks, costPara.id));
  assert.equal(byId(r2.blocks, costPara.id).t, norm('Costs up 40 percent'));
});

test('inserting a duplicate of the commented block keeps content correct (identical-text case)', () => {
  const v1 = '<p>Same line</p><p>Same line</p>';
  const r1 = processPublish([], v1, 1);
  const second = r1.blocks[1];
  const comment = { anchor: { block_id: second.id, block_text: 'Same line', quote: 'Same line' } };
  const v2 = '<p>Same line</p><p>Same line</p><p>Same line</p>';
  const r2 = processPublish(r1.blocks, v2, r1.nextBlockNum);
  const resolved = resolveAnchor(comment.anchor, r2.blocks);
  assert.notEqual(resolved.block_id, null);
  // Whatever it lands on, the content under the comment is identical text.
  assert.equal(byId(r2.blocks, resolved.block_id).t, norm('Same line'));
});

test('light edit carries the id forward (fuzzy, >= 0.7) for threading/layout', () => {
  const r1 = processPublish([], '<p>The quarterly revenue grew by eighteen percent.</p>', 1);
  const id = r1.blocks[0].id;
  const r2 = processPublish(r1.blocks, '<p>The quarterly revenue grew by nineteen percent.</p>', r1.nextBlockNum);
  assert.equal(r2.blocks[0].id, id, 'small wording change should keep the same block id at the reconcile layer');
});

// Regression battery for the adversarial-review finding: a carried id whose text
// was EDITED must surface as soft (visible), never as a silent solid anchor.
const fp = (block, text) => ({ block_id: block.id, block_fingerprint: block.t, block_text: text });

test('CRITICAL: a flipped number on a carried block resolves SOFT, never silent solid', () => {
  const r1 = processPublish([], '<p>Revenue up 18 percent this year</p>', 1);
  const anchor = fp(r1.blocks[0], 'Revenue up 18 percent this year');
  const r2 = processPublish(r1.blocks, '<p>Revenue up 88 percent this year</p>', r1.nextBlockNum);
  assert.equal(r2.blocks[0].id, r1.blocks[0].id, 'reconcile still carries the id');
  const resolved = resolveAnchor(anchor, r2.blocks);
  assert.equal(resolved.block_id, r1.blocks[0].id);
  assert.equal(resolved.soft, true, '18% -> 88% must be flagged edited, not solid');
});

test('CRITICAL: a negation flip on a carried block resolves SOFT', () => {
  const r1 = processPublish([], '<p>The board approved the acquisition.</p>', 1);
  const anchor = fp(r1.blocks[0], 'The board approved the acquisition.');
  const r2 = processPublish(r1.blocks, '<p>The board did not approve the acquisition.</p>', r1.nextBlockNum);
  const resolved = resolveAnchor(anchor, r2.blocks);
  assert.notEqual(resolved.block_id, null);
  assert.equal(resolved.soft, true, 'approve -> not approve must be visible, not a solid anchor');
});

test('an unchanged block stays SOLID even when a sibling is heavily edited', () => {
  const r1 = processPublish([], '<p>Stable paragraph that never changes.</p><p>sibling</p>', 1);
  const anchor = fp(r1.blocks[0], 'Stable paragraph that never changes.');
  const r2 = processPublish(r1.blocks, '<p>Stable paragraph that never changes.</p><p>sibling rewritten entirely now</p>', r1.nextBlockNum);
  const resolved = resolveAnchor(anchor, r2.blocks);
  assert.equal(resolved.soft, false);
  assert.equal(resolved.block_id, r1.blocks[0].id);
});

test('cumulative drift across many small edits never yields a silent solid anchor', () => {
  // Each step is < 0.3 apart (so the id is carried) but the text walks far from the original.
  const steps = [
    'Our pricing strategy targets mid-market customers with a flat monthly fee.',
    'Our pricing strategy targets mid-market customers with a flat annual fee.',
    'Our pricing approach targets mid-market customers with a flat annual fee.',
    'Our pricing approach targets enterprise customers with a flat annual fee.',
    'Our pricing approach targets enterprise accounts with an annual contract.',
    'Our go-to-market plan targets enterprise accounts via an annual contract.',
  ];
  let r = processPublish([], `<p>${steps[0]}</p>`, 1);
  const anchor = fp(r.blocks[0], steps[0]);
  for (let i = 1; i < steps.length; i++) r = processPublish(r.blocks, `<p>${steps[i]}</p>`, r.nextBlockNum);
  const resolved = resolveAnchor(anchor, r.blocks);
  // The current text is far from the original; it must NOT be a confident solid anchor.
  if (resolved.block_id !== null) assert.equal(resolved.soft, true);
});

test('deleting the commented block → orphan (or visible soft re-anchor), never silent wrong anchor', () => {
  const r1 = processPublish([], '<p>Unique paragraph about widgets</p><p>Another about gadgets</p>', 1);
  const widgets = r1.blocks[0];
  const comment = { anchor: { block_id: widgets.id, block_text: 'Unique paragraph about widgets', quote: 'widgets' } };
  // v2 removes the widgets paragraph entirely.
  const r2 = processPublish(r1.blocks, '<p>Another about gadgets</p>', r1.nextBlockNum);
  const resolved = resolveAnchor(comment.anchor, r2.blocks);
  // Block id is gone, and the remaining block is too dissimilar → orphan.
  assert.equal(resolved.block_id, null);
});

test('resolveAnchor soft-re-anchors when the id is gone but a similar block remains', () => {
  const currentBlocks = [{ id: 'b9', t: norm('the quarterly revenue grew strongly this year') }];
  const anchor = { block_id: 'b-gone', block_text: 'the quarterly revenue grew this year', quote: 'revenue' };
  const r = resolveAnchor(anchor, currentBlocks);
  assert.equal(r.block_id, 'b9');
  assert.equal(r.soft, true);
});

test('invariant: a resolved comment always lands on similar content (or orphans)', () => {
  const r1 = processPublish([], '<p>Customers love the new onboarding flow we shipped last week.</p><p>Pricing stays flat.</p>', 1);
  const anchor = { block_id: r1.blocks[0].id, block_text: 'Customers love the new onboarding flow we shipped last week.', quote: 'onboarding flow' };
  const r2 = processPublish(r1.blocks, '<p>Customers really love the brand-new onboarding flow that we shipped last week.</p><p>Pricing stays flat.</p>', r1.nextBlockNum);
  const resolved = resolveAnchor(anchor, r2.blocks);
  if (resolved.block_id !== null) {
    const landed = r2.blocks.find((b) => b.id === resolved.block_id);
    assert.ok(similarity(norm(anchor.block_text), landed.t) >= 0.5, 'resolved block must be similar to the original');
  }
});

test('similarity basics', () => {
  assert.equal(similarity('hello', 'hello'), 1);
  assert.equal(similarity('', ''), 0);
  assert.ok(similarity('revenue up 18%', 'revenue up 19%') > 0.7);
  assert.ok(similarity('completely different', 'revenue up 18%') < 0.5);
});

test('cross-contamination: editing one block does not disturb its neighbours ids', () => {
  const r1 = processPublish([], '<p>One</p><p>Two</p><p>Three</p>', 1);
  const [a, b, c] = r1.blocks.map((x) => x.id);
  // Edit only the middle block beyond the carry threshold.
  const r2 = processPublish(r1.blocks, '<p>One</p><p>Completely rewritten middle</p><p>Three</p>', r1.nextBlockNum);
  assert.equal(r2.blocks[0].id, a);
  assert.equal(r2.blocks[2].id, c);
  assert.notEqual(r2.blocks[1].id, b); // the rewritten one is genuinely new
});

// --- refinements: short-block containment, thin-overlap floor, empty-block stability ---

test('short-block containment: a small addition re-anchors instead of orphaning', () => {
  assert.ok(anchorSim(norm('ROI'), norm('Net ROI')) >= 0.99, 'ROI ⊂ Net ROI');
  assert.ok(anchorSim(norm('API'), norm('API v2')) >= 0.99, 'API ⊂ API v2');
  const r1 = processPublish([], '<h2>ROI</h2><p>body text here</p>', 1);
  const anchor = { block_id: r1.blocks[0].id, block_fingerprint: r1.blocks[0].t, block_text: 'ROI' };
  const r2 = processPublish(r1.blocks, '<h2>Net ROI</h2><p>body text here</p>', r1.nextBlockNum);
  assert.notEqual(resolveAnchor(anchor, r2.blocks).block_id, null, 'a one-word heading edit must not orphan');
});

test('short containment does not latch onto an unrelated long paragraph', () => {
  assert.equal(anchorSim(norm('ROI'), norm('Our ROI analysis covers twelve product lines in detail this year')), 0);
});

test('repeated low-entropy text does not inflate similarity into a false carry', () => {
  assert.ok(anchorSim(norm('na na na na na'), norm('la la la la la')) < 0.7);
});

test('thin overlap (too few distinct shared bigrams) is refused', () => {
  assert.equal(anchorSim('ab', 'az'), 0);
});

test('empty-text blocks keep their ids across an identical republish (no churn)', () => {
  const html = '<table><tr><td>A</td><td></td></tr><tr><td></td><td>B</td></tr></table>';
  const r1 = processPublish([], html, 1);
  const r2 = processPublish(r1.blocks, html, r1.nextBlockNum);
  assert.deepEqual(r2.blocks.map((b) => b.id), r1.blocks.map((b) => b.id), 'no new ids on a no-op republish');
  assert.equal(r2.nextBlockNum, r1.nextBlockNum, 'nextBlockNum does not grow');
});

// Empty-block re-matching is keyed on TAG, not just position: an empty cell must
// not inherit an empty block of a different tag, and an inserted empty mints fresh.
test('empty-text blocks are re-matched by tag (different tag → fresh id; insert → fresh)', () => {
  assert.equal(reconcile([{ id: 'b1', t: '', tag: 'td' }], [{ t: '', tag: 'td' }], 5).ids[0], 'b1', 'same tag carries');
  assert.equal(reconcile([{ id: 'b1', t: '', tag: 'td' }], [{ t: '', tag: 'th' }], 5).ids[0], 'b5', 'different tag mints fresh');
  // Two empties carry by position; a third (inserted) empty mints a fresh id.
  const prev = [{ id: 'b1', t: '', tag: 'td' }, { id: 'b2', t: '', tag: 'td' }];
  const next = [{ t: '', tag: 'td' }, { t: '', tag: 'td' }, { t: '', tag: 'td' }];
  assert.deepEqual(reconcile(prev, next, 5).ids, ['b1', 'b2', 'b5']);
});

// --- threshold boundaries -------------------------------------------------
// The pre-existing suite only used strict-inequality examples; pin behavior AT
// and JUST BELOW each threshold. Note the deliberate asymmetry:
//   reconcile's MATCH_THRESHOLD (0.7) is INCLUSIVE — the nearest-by-position
//     tiebreak (s === bestSim && d < bestDist) fires at exactly the threshold
//     (this is why the carry test above is named ">= 0.7").
//   resolveAnchor's RESOLVE_THRESHOLD (0.5) is EXCLUSIVE — a strict `s > 0.5`.
// The synthetic strings hit the Dice values exactly and each shares >= 3
// distinct bigrams, so the fix-#2 thin-overlap floor is not the deciding factor.

test('boundary: reconcile carries at EXACTLY 0.7 (MATCH_THRESHOLD is inclusive)', () => {
  assert.equal(similarity('abcdefghijk', 'abcdefghpqr'), 0.7);
  const rec = reconcile([{ id: 'b1', t: 'abcdefghijk', tag: 'p' }], [{ t: 'abcdefghpqr', tag: 'p' }], 9);
  assert.equal(rec.ids[0], 'b1');
});

test('boundary: reconcile does NOT carry just below 0.7', () => {
  assert.ok(similarity('abcdefghij', 'abcdefgwxy') < 0.7); // 0.6667
  const rec = reconcile([{ id: 'b1', t: 'abcdefghij', tag: 'p' }], [{ t: 'abcdefgwxy', tag: 'p' }], 9);
  assert.equal(rec.ids[0], 'b9');
});

test('boundary: resolveAnchor does NOT re-anchor at EXACTLY 0.5 (RESOLVE_THRESHOLD is exclusive)', () => {
  assert.equal(similarity('abcdefg', 'abcdxyz'), 0.5);
  const resolved = resolveAnchor({ block_id: 'gone', block_fingerprint: 'abcdefg' }, [{ id: 'b1', t: 'abcdxyz', tag: 'p' }]);
  assert.equal(resolved.block_id, null);
});

test('boundary: resolveAnchor re-anchors just above 0.5 and orphans just below', () => {
  assert.equal(similarity('abcdef', 'abcdxy'), 0.6); // just above → soft re-anchor
  assert.equal(resolveAnchor({ block_id: 'gone', block_fingerprint: 'abcdef' }, [{ id: 'b1', t: 'abcdxy', tag: 'p' }]).block_id, 'b1');
  assert.ok(similarity('abcdefg', 'abcdpqrs') < 0.5); // 0.4615 (shared = 3, so the floor passes) → orphan
  assert.equal(resolveAnchor({ block_id: 'gone', block_fingerprint: 'abcdefg' }, [{ id: 'b1', t: 'abcdpqrs', tag: 'p' }]).block_id, null);
});
