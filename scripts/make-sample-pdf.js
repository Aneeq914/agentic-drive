// Generates the bundled sample invoice PDF (dev only: needs the pdfkit devDependency).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'samples', 'invoice-printhub-INV-3310.pdf');
const doc = new PDFDocument({ margin: 56 });
doc.pipe(fs.createWriteStream(out));
doc.fontSize(20).text('PrintHub Studio');
doc.fontSize(14).text('INVOICE');
doc.moveDown();
doc.fontSize(11);
for (const line of [
  'Invoice Number: INV-3310',
  'Invoice Date: 2026-07-20',
  'Bill To: Agentic Drive Team, Marketing Department',
  '',
  'Summer Switch campaign flyers (5,000)      $1,980.00',
  'Event banners (4)                          $1,500.00',
  'Total Due: $3,480.00',
  '',
  'Thank you for printing with PrintHub Studio.',
]) doc.text(line);
doc.end();
console.log(`Wrote ${out}`);
