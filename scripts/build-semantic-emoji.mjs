// Build-time generator for the client-side semantic emoji engine.
//
// Inputs (already fetched into scripts/build-tmp/):
//   - fr.vec.head : top-N French fastText word vectors (300d), text format
//   - emoji-fr.json : emojibase FR data (label + tags per emoji)
//
// Output (committed, served lazily to the browser):
//   - public/data/sem-manifest.json : { dims, words[], emojis[] }
//   - public/data/sem-words.bin     : Int8Array [numWords x dims]
//   - public/data/sem-emojis.bin    : Int8Array [numEmojis x dims]
//
// The "AI" runs only here, once. The browser ships nothing but a table of
// int8 numbers and computes cosine similarity (a dot product) at runtime.

import fs from 'node:fs';
import readline from 'node:readline';

const TMP = new URL('./build-tmp/', import.meta.url);
const OUT = new URL('../public/data/', import.meta.url);
const VEC_FILE = new URL('fr.vec.head', TMP);
const EMOJI_FILE = new URL('emoji-fr.json', TMP);

const MAX_WORDS = Number(process.env.MAX_WORDS || 45000);
const DIMS = Number(process.env.DIMS || 48);
const SRC_DIMS = 300;

const STOPWORDS = new Set([
  'de', 'la', 'le', 'les', 'des', 'du', 'un', 'une', 'et', 'en', 'au', 'aux',
  'a', 'd', 'l', 's', 'ce', 'se', 'sa', 'son', 'ses', 'qui', 'que', 'pour',
  'par', 'sur', 'dans', 'avec', 'ou', 'ne', 'pas', 'il', 'elle', 'on', 'je',
  'tu', 'nous', 'vous', 'ils', 'elles', 'est', 'sont', 'plus', 'tres', 'tout',
]);

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalize(value)
    .split(' ')
    .filter(tok => tok.length >= 2 && /[a-z]/.test(tok));
}

// ---- 0. Fetch source data if missing --------------------------------------
const VEC_URL = 'https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.fr.300.vec.gz';
const EMOJI_URL = 'https://unpkg.com/emojibase-data@17.0.0/fr/data.json';

async function ensureInputs() {
  fs.mkdirSync(TMP, { recursive: true });
  if (!fs.existsSync(EMOJI_FILE)) {
    console.log('Fetching emojibase FR data...');
    const json = await (await fetch(EMOJI_URL)).text();
    fs.writeFileSync(EMOJI_FILE, json);
  }
  if (!fs.existsSync(VEC_FILE)) {
    // The .vec.gz is sorted by frequency, so we stream-decompress and stop once
    // we have enough lines — pulling ~50 MB instead of the full 1.3 GB.
    const need = Math.ceil(MAX_WORDS * 1.6) + 1;
    console.log(`Streaming top ${need} word vectors from fastText (early-stop)...`);
    const res = await fetch(VEC_URL);
    const reader = res.body
      .pipeThrough(new DecompressionStream('gzip'))
      .pipeThrough(new TextDecoderStream())
      .getReader();
    const out = fs.createWriteStream(VEC_FILE);
    let buf = '';
    let lines = 0;
    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        out.write(buf.slice(0, nl + 1));
        buf = buf.slice(nl + 1);
        if (++lines >= need) { await reader.cancel(); break outer; }
      }
    }
    out.end();
    await new Promise(r => out.on('close', r));
  }
}
await ensureInputs();

// ---- 1. Load word vectors -------------------------------------------------
console.log(`Loading up to ${MAX_WORDS} word vectors (${SRC_DIMS}d)...`);
const words = [];
const wordVecs = []; // Float32Array(300) per word
const wordIndex = new Map(); // normalized word -> row index

await new Promise((resolve, reject) => {
  const rl = readline.createInterface({ input: fs.createReadStream(VEC_FILE), crlfDelay: Infinity });
  let first = true;
  rl.on('line', line => {
    if (first) { first = false; return; } // skip "count dims" header
    if (words.length >= MAX_WORDS) { rl.close(); return; }
    const sp = line.indexOf(' ');
    if (sp < 0) return;
    const raw = line.slice(0, sp);
    const key = normalize(raw);
    if (!key || key.includes(' ') || key.length < 2 || !/[a-z]/.test(key)) return;
    if (STOPWORDS.has(key) || wordIndex.has(key)) return; // keep most frequent
    const parts = line.slice(sp + 1).split(' ');
    if (parts.length < SRC_DIMS) return;
    const v = new Float32Array(SRC_DIMS);
    for (let i = 0; i < SRC_DIMS; i++) v[i] = parseFloat(parts[i]);
    wordIndex.set(key, words.length);
    words.push(key);
    wordVecs.push(v);
  });
  rl.on('close', resolve);
  rl.on('error', reject);
});
const N = words.length;
console.log(`Loaded ${N} usable word vectors.`);

// ---- 2. PCA: fit projection 300 -> DIMS on the word matrix ----------------
console.log(`Fitting PCA ${SRC_DIMS} -> ${DIMS}...`);
const mean = new Float64Array(SRC_DIMS);
for (const v of wordVecs) for (let i = 0; i < SRC_DIMS; i++) mean[i] += v[i];
for (let i = 0; i < SRC_DIMS; i++) mean[i] /= N;

// Covariance (300x300), accumulated over centered word vectors.
const cov = new Float64Array(SRC_DIMS * SRC_DIMS);
const centered = new Float64Array(SRC_DIMS);
for (const v of wordVecs) {
  for (let i = 0; i < SRC_DIMS; i++) centered[i] = v[i] - mean[i];
  for (let i = 0; i < SRC_DIMS; i++) {
    const ci = centered[i];
    if (ci === 0) continue;
    const row = i * SRC_DIMS;
    for (let j = i; j < SRC_DIMS; j++) cov[row + j] += ci * centered[j];
  }
}
for (let i = 0; i < SRC_DIMS; i++) {
  for (let j = i; j < SRC_DIMS; j++) {
    const val = cov[i * SRC_DIMS + j] / N;
    cov[i * SRC_DIMS + j] = val;
    cov[j * SRC_DIMS + i] = val;
  }
}

function matvec(m, x, out) {
  for (let i = 0; i < SRC_DIMS; i++) {
    let s = 0;
    const row = i * SRC_DIMS;
    for (let j = 0; j < SRC_DIMS; j++) s += m[row + j] * x[j];
    out[i] = s;
  }
}

// Top-DIMS eigenvectors via power iteration + deflation.
const components = []; // Float64Array(300) each
const tmp = new Float64Array(SRC_DIMS);
for (let c = 0; c < DIMS; c++) {
  let v = new Float64Array(SRC_DIMS);
  for (let i = 0; i < SRC_DIMS; i++) v[i] = Math.random() - 0.5;
  let norm = Math.hypot(...v);
  for (let i = 0; i < SRC_DIMS; i++) v[i] /= norm;
  for (let iter = 0; iter < 100; iter++) {
    matvec(cov, v, tmp);
    norm = Math.hypot(...tmp);
    if (norm === 0) break;
    for (let i = 0; i < SRC_DIMS; i++) tmp[i] /= norm;
    let diff = 0;
    for (let i = 0; i < SRC_DIMS; i++) diff += Math.abs(tmp[i] - v[i]);
    v = Float64Array.from(tmp);
    if (diff < 1e-6) break;
  }
  // eigenvalue (Rayleigh quotient) for deflation
  matvec(cov, v, tmp);
  let lambda = 0;
  for (let i = 0; i < SRC_DIMS; i++) lambda += v[i] * tmp[i];
  for (let i = 0; i < SRC_DIMS; i++) {
    const row = i * SRC_DIMS;
    for (let j = 0; j < SRC_DIMS; j++) cov[row + j] -= lambda * v[i] * v[j];
  }
  components.push(v);
}
console.log(`Extracted ${components.length} principal components.`);

// Project a raw 300d vector into DIMS, return unit-normalized Float64Array.
function project(raw) {
  const out = new Float64Array(DIMS);
  for (let c = 0; c < DIMS; c++) {
    const comp = components[c];
    let s = 0;
    for (let i = 0; i < SRC_DIMS; i++) s += (raw[i] - mean[i]) * comp[i];
    out[c] = s;
  }
  const norm = Math.hypot(...out) || 1;
  for (let c = 0; c < DIMS; c++) out[c] /= norm;
  return out;
}

function quantize(unitVec, target, offset) {
  for (let c = 0; c < DIMS; c++) {
    let q = Math.round(unitVec[c] * 127);
    if (q > 127) q = 127; else if (q < -127) q = -127;
    target[offset + c] = q;
  }
}

// ---- 3. Quantize word table ----------------------------------------------
const wordsBin = new Int8Array(N * DIMS);
for (let r = 0; r < N; r++) quantize(project(wordVecs[r]), wordsBin, r * DIMS);

// ---- 4. Build emoji vectors (weighted mean of keyword word-vectors) -------
console.log('Building emoji vectors...');
const emojiData = JSON.parse(fs.readFileSync(EMOJI_FILE, 'utf8'));
const emojis = [];
const emojiVecs = [];
let skipped = 0;
for (const entry of emojiData) {
  if (!entry.emoji) continue;
  const acc = new Float64Array(SRC_DIMS);
  let weight = 0;
  const add = (text, w) => {
    for (const tok of tokenize(text)) {
      if (STOPWORDS.has(tok)) continue;
      const idx = wordIndex.get(tok);
      if (idx === undefined) continue;
      const v = wordVecs[idx];
      for (let i = 0; i < SRC_DIMS; i++) acc[i] += v[i] * w;
      weight += w;
    }
  };
  add(entry.label, 2);
  for (const tag of entry.tags || []) add(tag, 1);
  if (weight === 0) { skipped++; continue; }
  for (let i = 0; i < SRC_DIMS; i++) acc[i] /= weight;
  emojis.push(entry.emoji);
  emojiVecs.push(acc);
}
console.log(`Emoji vectors: ${emojis.length} kept, ${skipped} skipped (no resolvable keyword).`);

const emojisBin = new Int8Array(emojis.length * DIMS);
for (let r = 0; r < emojis.length; r++) {
  quantize(project(Float32Array.from(emojiVecs[r])), emojisBin, r * DIMS);
}

// ---- 5. Write artifacts ---------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(new URL('sem-words.bin', OUT), Buffer.from(wordsBin.buffer));
fs.writeFileSync(new URL('sem-emojis.bin', OUT), Buffer.from(emojisBin.buffer));
fs.writeFileSync(new URL('sem-manifest.json', OUT), JSON.stringify({
  dims: DIMS,
  words,
  emojis,
}));

const mb = b => (b / 1024 / 1024).toFixed(2);
console.log('\nDone.');
console.log(`  sem-words.bin   ${mb(wordsBin.byteLength)} MB (${N} x ${DIMS})`);
console.log(`  sem-emojis.bin  ${mb(emojisBin.byteLength)} MB (${emojis.length} x ${DIMS})`);
console.log(`  sem-manifest.json ${mb(fs.statSync(new URL('sem-manifest.json', OUT)).size)} MB`);
