/**
 * Synthetic market intelligence: the files the generator feeds to the market-intel
 * service.
 *
 * Every payload is built from the user's own seeded PRNG, so a run with the same
 * LOADGEN_SEED submits the same files in the same order — and because the processor's
 * timing is derived from the payload's digest, that makes the *processing latency*
 * reproducible too, not just the request pattern.
 *
 * There are no dependencies here, which is the constraint that shapes the file
 * builders below: the PDF and the PNG are assembled from bytes by hand rather than by
 * a library, because this service's whole HTTP stack is Node's built-in `fetch` and
 * adding a dependency to generate a fake PDF would be a poor trade.
 *
 * The *content* is deliberately plausible-but-obviously-synthetic, for the same reason
 * the market data is: these files carry invented issuer names and invented numbers, and
 * nothing downstream extracts anything from them. See the processor's own note.
 */
import { deflateSync } from 'node:zlib';

import { pick, randomInt } from './random.js';

// The fictional issuers, matching the tone of the generated universe rather than real
// S&P 500 constituents — a file claiming to be Apple's earnings would be the one
// misleading artefact in this repo.
const ISSUERS = [
  'Nova Industries', 'Atlas Grid', 'Meridian Capital', 'Capstone Logistics',
  'Helio Materials', 'Vantage Foods', 'Orbit Semiconductor', 'Keystone Energy',
  'Lumen Health', 'Pioneer Rail', 'Summit Chemical', 'Beacon Retail',
];

const EVENTS = [
  'reported quarterly revenue above guidance',
  'announced a plant expansion',
  'disclosed a supply agreement with an unnamed counterparty',
  'named a new chief financial officer',
  'guided the next quarter below consensus',
  'completed a bolt-on acquisition',
  'reported an inventory writedown',
  'renewed its buyback authorisation',
];

const SOURCES = ['wire', 'broker-note', 'filing', 'transcript', 'press-release'];

const sentence = (rng) =>
  `${pick(rng, ISSUERS)} ${pick(rng, EVENTS)}. ` +
  `Figures are fabricated for a demo (${randomInt(rng, 100, 9999)}).`;

/** Text that reads like a wire story, padded to roughly `targetBytes`. */
function textReport(rng, targetBytes) {
  const parts = [`SOURCE: ${pick(rng, SOURCES)}`, `SYNTHETIC DEMO DATA — NOT REAL RESEARCH`, ''];
  let bytes = parts.join('\n').length;
  while (bytes < targetBytes) {
    const line = sentence(rng);
    parts.push(line);
    bytes += line.length + 1;
  }
  return { body: Buffer.from(parts.join('\n'), 'utf8'), contentType: 'text/plain', ext: 'txt' };
}

function jsonReport(rng, targetBytes) {
  const items = [];
  let bytes = 64;
  while (bytes < targetBytes) {
    const item = {
      issuer: pick(rng, ISSUERS),
      event: pick(rng, EVENTS),
      source: pick(rng, SOURCES),
      // Invented, and labelled as such by the envelope below.
      sentiment: Math.round((rng() * 2 - 1) * 100) / 100,
      confidence: Math.round(rng() * 100) / 100,
    };
    items.push(item);
    bytes += JSON.stringify(item).length + 1;
  }
  const envelope = { synthetic: true, note: 'demo data, no real research', items };
  return {
    body: Buffer.from(JSON.stringify(envelope, null, 2), 'utf8'),
    contentType: 'application/json',
    ext: 'json',
  };
}

function csvReport(rng, targetBytes) {
  const rows = ['issuer,source,event,sentiment,synthetic'];
  let bytes = rows[0].length;
  while (bytes < targetBytes) {
    const row = `"${pick(rng, ISSUERS)}",${pick(rng, SOURCES)},"${pick(rng, EVENTS)}",` +
      `${Math.round((rng() * 2 - 1) * 100) / 100},true`;
    rows.push(row);
    bytes += row.length + 1;
  }
  return { body: Buffer.from(rows.join('\n'), 'utf8'), contentType: 'text/csv', ext: 'csv' };
}

/**
 * A real, openable single-page PDF, assembled by hand.
 *
 * Valid structure — header, four objects, xref table, trailer — because a processor
 * that one day actually parses these should be given something parseable rather than
 * bytes with a `.pdf` name. The body text is one line; the size is made up with a
 * comment stream, which is legal anywhere in a PDF and is the cheapest way to hit a
 * target byte count without hand-computing offsets for thousands of objects.
 */
function pdfReport(rng, targetBytes) {
  const line = sentence(rng).replace(/[()\\]/g, '');
  const content = `BT /F1 11 Tf 54 720 Td (SYNTHETIC DEMO DATA) Tj 0 -18 Td (${line}) Tj ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  // Padding as PDF comments, before the xref so the offsets already recorded stay
  // correct. One long comment line rather than many, to keep this cheap.
  const overhead = pdf.length + 200;
  if (targetBytes > overhead) {
    pdf += `% ${'padding '.repeat(Math.ceil((targetBytes - overhead) / 8))}\n`;
  }

  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return { body: Buffer.from(pdf, 'latin1'), contentType: 'application/pdf', ext: 'pdf' };
}

/** CRC-32, for the PNG chunks. Table built once. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
};

/**
 * A real PNG: a small block of noise, which is both a valid image and incompressible,
 * so the file size is predictable from the requested dimensions. A screenshot of a
 * chart is what this stands in for, and those do not compress either.
 *
 * Padding goes in a trailing private `daTa` chunk rather than after IEND — a decoder
 * ignores an unknown ancillary chunk, where trailing garbage makes the file invalid.
 */
function pngReport(rng, targetBytes) {
  const side = Math.max(8, Math.min(220, Math.round(Math.sqrt(targetBytes / 3.2))));

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(side * (side * 3 + 1));
  for (let y = 0; y < side; y += 1) {
    const rowStart = y * (side * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < side * 3; x += 1) raw[rowStart + 1 + x] = Math.floor(rng() * 256);
  }

  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
  ];

  const soFar = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (targetBytes > soFar + 24) {
    const padding = Buffer.alloc(targetBytes - soFar - 24);
    for (let i = 0; i < padding.length; i += 1) padding[i] = Math.floor(rng() * 256);
    chunks.push(pngChunk('daTa', padding));
  }
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));

  return { body: Buffer.concat(chunks), contentType: 'image/png', ext: 'png' };
}

/**
 * The mix. Weighted toward the small text formats because that is what a wire feed
 * mostly is, with the occasional large PDF or screenshot — which is exactly the shape
 * that makes size-dependent processing time visible in the metrics rather than
 * averaged away.
 */
const BUILDERS = [
  { name: 'text', weight: 34, build: textReport },
  { name: 'json', weight: 24, build: jsonReport },
  { name: 'csv', weight: 14, build: csvReport },
  { name: 'pdf', weight: 18, build: pdfReport },
  { name: 'png', weight: 10, build: pngReport },
];

const TOTAL_WEIGHT = BUILDERS.reduce((sum, builder) => sum + builder.weight, 0);

/**
 * A log-ish size distribution: mostly small, a long tail of large. A uniform pick
 * between the bounds would make almost every file large, since the range spans three
 * orders of magnitude — and then every request would sit at the processor's ceiling.
 */
function targetBytes(rng, minBytes, maxBytes) {
  const spread = Math.log(maxBytes / minBytes);
  return Math.round(minBytes * Math.exp(rng() * rng() * spread));
}

/** One synthetic file: body, content type, and a filename that hints at its provenance. */
export function buildIntel(rng, { minBytes, maxBytes }) {
  let choice = rng() * TOTAL_WEIGHT;
  const builder = BUILDERS.find((candidate) => (choice -= candidate.weight) <= 0) ?? BUILDERS[0];

  const { body, contentType, ext } = builder.build(rng, targetBytes(rng, minBytes, maxBytes));
  const source = pick(rng, SOURCES);
  return {
    body,
    contentType,
    kind: builder.name,
    filename: `${source}-${randomInt(rng, 1000, 9999)}.${ext}`,
  };
}
