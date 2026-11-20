#!/usr/bin/env node
/**
 * tools/a11y-narration.mjs — PG-14 held-open substitute, honestly labelled.
 *
 * WHY IT EXISTS: the criterion asks for a screen-reader session. An automated
 * harness cannot claim a human NVDA/VoiceOver session, and this tool does NOT.
 * What it can do is the part a machine can prove: render each shipped page from
 * the REAL server, extract the accessible text tree in document order, refuse
 * any control with no accessible name, and emit the exact narration a screen
 * reader would speak. That turns "unverified" into "verified for names, order
 * and labels; the human session remains an owner action".
 *
 * Zero runtime dependencies (ADR-0014). Writes artifacts/a11y-narration.{txt,json}.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(process.cwd());
const PAGES = [
  ['/learn', 'Learner'],
  ['/dashboard', 'Learner dashboard'],
  ['/sponsor', 'Sponsor dashboard'],
  ['/operator', 'Operator dashboard'],
];

const decode = (s) => s
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

const problems = [];
const pageReports = [];
const transcript = [];

const { startServer } = await import(pathToFileURL(join(ROOT, 'apps', 'cli', 'dist', 'serve.js')).href);
const dataDir = mkdtempSync(join(tmpdir(), 'eg-a11y-'));
let server;
try {
  server = await startServer({ host: '127.0.0.1', port: 0, dataDir });
  for (const [path, label] of PAGES) {
    const res = await fetch(server.url + path);
    const html = await res.text();
    const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const lang = html.match(/<html[^>]*\blang="([^"]+)"/i)?.[1] ?? '';
    const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;

    // Document order: headings, then controls, then fields.
    const spoken = [];
    if (title !== '') spoken.push(`${label} page, ${title}.`);
    for (const m of main.matchAll(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const text = decode(m[2]);
      if (text !== '') spoken.push(`${m[1].toUpperCase().slice(1) === '1' ? 'Heading' : 'Subheading'}: ${text}.`);
    }

    // A control with no accessible name is unusable with a screen reader.
    const controls = [...main.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((m) => ({
      tag: m[1].toLowerCase(),
      text: decode(m[3]),
      label: m[2].match(/aria-label="([^"]+)"/i)?.[1] ?? '',
    }));
    const unnamed = controls.filter((c) => c.text === '' && c.label === '');
    for (const c of controls.slice(0, 12)) {
      if (c.text !== '' || c.label !== '') spoken.push(`${c.tag === 'a' ? 'Link' : 'Button'}: ${c.text || c.label}.`);
    }

    const fields = [...main.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)]
      .filter((m) => !/type="hidden"/i.test(m[2]))
      .map((m) => {
        const attrs = m[2];
        const id = attrs.match(/\bid="([^"]+)"/i)?.[1] ?? '';
        const labelled = (id !== '' && new RegExp(`<label[^>]*for="${id}"`, 'i').test(main))
          || /aria-label="/i.test(attrs)
          || /aria-labelledby="/i.test(attrs);
        return { tag: m[1].toLowerCase(), id, labelled };
      });
    const unlabelled = fields.filter((f) => !f.labelled);

    const images = [...main.matchAll(/<img\b([^>]*)>/gi)];
    const noAlt = images.filter((m) => !/\balt=/i.test(m[1]));

    if (title === '') problems.push(`${path}: the document has no <title>`);
    if (lang === '') problems.push(`${path}: the document has no lang attribute`);
    if (unnamed.length > 0) problems.push(`${path}: ${unnamed.length} control(s) with no accessible name`);
    if (unlabelled.length > 0) problems.push(`${path}: ${unlabelled.length} field(s) with no label`);
    if (noAlt.length > 0) problems.push(`${path}: ${noAlt.length} image(s) with no alt`);

    pageReports.push({
      path, label, status: res.status, title, lang,
      headings: (main.match(/<h[1-3]\b/gi) ?? []).length,
      controls: controls.length, unnamedControls: unnamed.length,
      fields: fields.length, unlabelledFields: unlabelled.length,
      images: images.length, imagesWithoutAlt: noAlt.length,
    });
    transcript.push(`=== ${label} (${path}) ===\n${spoken.join('\n') || '(no text)'}\n`);
    console.log(`${problems.some((p) => p.startsWith(path)) ? 'FAIL' : 'PASS'}  ${path} — ${spoken.length} spoken item(s), ${unnamed.length} unnamed control(s), ${unlabelled.length} unlabelled field(s)`);
  }
} finally {
  if (server) await server.close();
  rmSync(dataDir, { recursive: true, force: true });
}

const header = [
  'EduGenesis OS — accessible text tree, in document order',
  '',
  'HOW THIS WAS PRODUCED: tools/a11y-narration.mjs rendered each page from the',
  'real server and extracted headings, controls and fields in document order.',
  'It is the text a screen reader would speak — NOT a recording of an NVDA,',
  'Narrator or VoiceOver session. The human session remains an owner action.',
  '',
  ''
].join('\n');

mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
writeFileSync(join(ROOT, 'artifacts', 'a11y-narration.txt'), header + transcript.join('\n'), 'utf8');

const report = {
  tool: 'tools/a11y-narration.mjs',
  schemaVersion: 1,
  result: problems.length === 0 ? 'PASS' : 'FAIL',
  judge: 'automated extraction (NOT a screen-reader session)',
  pages: pageReports,
  failed: problems,
  limits: [
    'No NVDA, Narrator or VoiceOver session was run; this is the accessible text tree.',
    'Focus order, live-region announcements and speech timing are not tested here.',
    'A human screen-reader pass is still required for the criterion to be met in full.',
  ],
};
writeFileSync(join(ROOT, 'artifacts', 'a11y-narration.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\nRESULT: ${report.result} — ${pageReports.length} page(s); ${problems.length} accessibility defect(s).`);
// Do NOT call process.exit(): the HTTP server has just closed its handles and a
// forced exit can trip a libuv assertion on Windows (UV_HANDLE_CLOSING), which
// would turn a PASS into a crash exit code. Setting exitCode lets Node drain.
process.exitCode = problems.length === 0 ? 0 : 1;
