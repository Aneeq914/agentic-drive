/**
 * Text extraction: turns an uploaded file (bytes + name) into plain text.
 *
 * ── IN SIMPLE WORDS ──
 * The agents can only read plain text. This module is the "reader" that opens
 * an uploaded file and hands back its words. Text, Markdown and CSV files are
 * already text, so they are just cleaned up a bit. PDFs are opened with a PDF
 * library and their words are pulled out.
 *
 * ── BUSINESS RULES ──
 * - Only .txt, .md, .csv and .pdf are accepted (spec §2 "File types"). The
 *   extension check ignores case, so "x.CSV" is accepted. Anything else is
 *   rejected with UnsupportedFileError, whose message tells the user which
 *   types are allowed.
 * - A PDF that cannot be parsed (corrupt or not really a PDF) is rejected
 *   with ExtractError, so the upload can fail with a readable message instead
 *   of storing junk (plan Review Focus #2).
 * - A PDF with no text layer returns '' and is NOT an error. OCR is out of
 *   scope (spec §2), so such files are still stored and the Organizer labels
 *   them "(no readable text)" (plan Review Focus #3).
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - pdf-parse v2 adds "-- 1 of 1 --" page markers to the text. They are
 *   stripped because otherwise they show up in summaries, search snippets and
 *   synthesized documents as if they were part of the content.
 * - A leading UTF-8 BOM is stripped and CRLF is turned into LF. Without this,
 *   files saved on Windows produce a stray invisible character in the first
 *   word and "\r" at the end of every line, which breaks line-based parsing
 *   (CSV rows, action-item lists) in the agents.
 * - Two different error classes exist so the server can tell "wrong file
 *   type" apart from "right type but unreadable"; both are meant to become a
 *   400, never a 500.
 * - The parser is always destroyed in `finally`, so a failed parse does not
 *   leave the PDF worker's resources hanging.
 *
 * ── DO NOT ──
 * - Do not treat an empty/image-only PDF as an error; it must return ''.
 * - Do not add new extensions here without also updating SUPPORTED_EXTS users
 *   (upload filter, UI hint) and the spec.
 * - Do not throw a plain Error for bad input; callers rely on the two classes
 *   to choose the status code.
 */
import path from 'node:path';
import { PDFParse } from 'pdf-parse';

export const SUPPORTED_EXTS = ['.txt', '.md', '.csv', '.pdf'];

export class UnsupportedFileError extends Error {}
export class ExtractError extends Error {}

export async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!SUPPORTED_EXTS.includes(ext)) {
    throw new UnsupportedFileError(`"${filename}" is not supported. Upload .txt, .md, .csv or .pdf files.`);
  }
  if (ext !== '.pdf') {
    return buffer.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  }
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    // pdf-parse v2 appends "-- 1 of 1 --" page markers; they are noise for every agent.
    return result.text.replace(/^-- \d+ of \d+ --$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  } catch (err) {
    throw new ExtractError(`Couldn't read text from "${filename}": ${err.message}`);
  } finally {
    await parser.destroy().catch(() => {});
  }
}
