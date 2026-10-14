import { test } from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { extractText, UnsupportedFileError, ExtractError } from '../src/extract.js';

function makePdf(lines) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    for (const l of lines) doc.text(l);
    doc.end();
  });
}

test('reads plain text, strips BOM and CRLF', async () => {
  assert.equal(await extractText(Buffer.from('﻿a\r\nb'), 'x.md'), 'a\nb');
});

test('reads csv as text', async () => {
  assert.equal(await extractText(Buffer.from('a,b\n1,2'), 'x.CSV'), 'a,b\n1,2');
});

test('reads pdf text without page markers', async () => {
  const text = await extractText(await makePdf(['INVOICE INV-3310', 'Total Due: $3,480.00']), 'inv.pdf');
  assert.match(text, /INV-3310/);
  assert.match(text, /Total Due: \$3,480\.00/);
  assert.doesNotMatch(text, /-- 1 of 1 --/);
});

test('pdf with no text returns empty string', async () => {
  assert.equal(await extractText(await makePdf([]), 'blank.pdf'), '');
});

test('rejects unsupported extensions', async () => {
  await assert.rejects(() => extractText(Buffer.from('x'), 'photo.png'), UnsupportedFileError);
});

test('corrupt pdf throws ExtractError', async () => {
  await assert.rejects(() => extractText(Buffer.from('not a pdf'), 'bad.pdf'), ExtractError);
});
