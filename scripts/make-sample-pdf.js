// Generates the bundled sample PDFs in src/samples/ (dev only: needs the pdfkit devDependency).
// Brightleaf Labs mock data: one PDF per kind that needs a PDF example (invoices, a proposal, a resume).
// The PrintHub invoice must keep exactly the same text as before: tests and docs rely on it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const samplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'samples');

// Writes one PDF: a large title, an optional subtitle, then one line of 11pt text per entry.
// A line starting with "## " is drawn as a bold section heading.
function writePdf(name, { title, subtitle, lines }) {
  const out = path.join(samplesDir, name);
  const doc = new PDFDocument({ margin: 56 });
  const done = new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(out);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.pipe(stream);
  });
  doc.fontSize(20).text(title);
  if (subtitle) doc.fontSize(14).text(subtitle);
  doc.moveDown();
  doc.fontSize(11);
  for (const line of lines) {
    if (line.startsWith('## ')) {
      doc.moveDown(0.5).font('Helvetica-Bold').text(line.slice(3)).font('Helvetica');
    } else {
      doc.text(line);
    }
  }
  doc.end();
  return done.then(() => console.log(`Wrote ${out}`));
}

const pdfs = {
  // Unchanged original sample (same title, subtitle and lines as the first version of this script).
  'invoice-printhub-INV-3310.pdf': {
    title: 'PrintHub Studio',
    subtitle: 'INVOICE',
    lines: [
      'Invoice Number: INV-3310',
      'Invoice Date: 2026-07-20',
      'Bill To: Agentic Drive Team, Marketing Department',
      '',
      'Summer Switch campaign flyers (5,000)      $1,980.00',
      'Event banners (4)                          $1,500.00',
      'Total Due: $3,480.00',
      '',
      'Thank you for printing with PrintHub Studio.',
    ],
  },

  'invoice-officeworks-INV-7781.pdf': {
    title: 'OfficeWorks Furniture Co.',
    subtitle: 'TAX INVOICE',
    lines: [
      'Vendor: OfficeWorks Furniture Co.',
      '114 Ferozepur Road, Lahore. NTN 3381920-4',
      'Invoice Number: INV-7781',
      'Invoice Date: 2026-08-28',
      'Quote reference: Q-2026-0457 (accepted 2026-08-14)',
      'Payment terms: Net 14 (due 2026-09-11)',
      '',
      'Bill To: Brightleaf Labs (Pvt.) Ltd., Attn: Usman Tariq (Ops & HR)',
      'Deliver To: Plot 42, Main Boulevard, Gulberg III, Lahore 54660',
      'Delivered and assembled: 2026-08-28',
      '',
      '## Items',
      'ErgoPro mesh office chair, black (14 x $185.00)           $2,590.00',
      'Electric sit-stand desk, 140 cm (2 x $420.00)              $840.00',
      'Delivery and on-site assembly                                $60.00',
      '',
      'Subtotal                                                  $3,490.00',
      'Sales tax 5%                                                $174.50',
      '',
      'Bank transfer to: OfficeWorks Furniture Co., Habib Bank Ltd., IBAN PK12 HABB 0011 2233 4455 6677',
      'Chairs carry a 5-year warranty on the frame and gas lift. Keep this invoice as proof of purchase.',
      'Total Due: $3,664.50',
    ],
  },

  'northwind-patient-app-proposal.pdf': {
    title: 'Proposal: Northwind Health Patient App',
    subtitle: 'Brightleaf Labs',
    lines: [
      'Proposal No.: BL-P-2026-014',
      'Date: 2026-07-28        Valid until: 2026-08-27',
      'Prepared for: Dr. Nadia Hussain, Chief Digital Officer, Northwind Health',
      'Prepared by: Zara Sheikh (Product Manager), Daniyal Qureshi (Engineering Lead), Saad Mirza (Account Manager)',
      'Confidential under mutual NDA BL-NDA-2026-012 (signed 2026-07-14).',
      '',
      '## 1. The problem',
      "Northwind Health runs 6 clinics in Lahore. About 70% of appointments are still booked by phone,",
      'front desks miss roughly 1 in 4 calls at peak hours, and 22% of booked patients do not show up.',
      'Patients have to visit a clinic in person to collect their lab results.',
      '',
      '## 2. What we propose',
      'A patient app for iOS and Android (one React Native codebase) that lets patients:',
      '- book, reschedule and cancel appointments at any of the 6 clinics',
      '- get SMS and push reminders 24 hours and 2 hours before a visit',
      "- see lab results as soon as a doctor releases them in Northwind's clinic system",
      '- keep family members (children, parents) under one account',
      '',
      '## 3. Phases and investment',
      'Phase 1 - Discovery (4 weeks): workshops, 12 patient interviews, architecture, prototype   $10,800',
      'Phase 2 - Design and build (16 weeks): app, backend, clinic-system integration, QA         $86,000',
      'Phase 3 - Support and hosting (optional, after launch): per month                          $3,200',
      'Phases 1 and 2 total: $96,800 (fixed price). Phase 1 can be bought on its own.',
      'Payment: Phase 1 is invoiced on completion, Net 30. Phase 2 is billed 30/40/30 against milestones.',
      '',
      '## 4. Success measures',
      '- 40% of appointments booked in the app within 6 months of launch',
      '- No-show rate down from 22% to under 12%',
      '- Lab-result pickups at the front desk down by 60%',
      '',
      '## 5. Data protection',
      'No real patient data is used during discovery. Before Phase 2 handles patient records, the parties',
      'will sign a data processing agreement, and the app will encrypt data at rest and keep audit logs.',
      '',
      '## 6. Team',
      'Zara Sheikh (product), Mehwish Javed (design), Daniyal Qureshi and a senior backend engineer',
      '(engineering), Ali Hassan (QA). Ayesha Malik (CEO) is the executive sponsor.',
      '',
      'To accept Phase 1, sign and return this proposal by 2026-08-27.',
    ],
  },

  'resume-priya-nair-product-designer.pdf': {
    title: 'Priya Nair',
    subtitle: 'Product Designer',
    lines: [
      'Dubai, UAE (open to relocating to Lahore) | priya.nair@example.com | +971 50 000 4821 | priyanair.example',
      '',
      '## Summary',
      'Product designer with 7 years of experience in e-commerce and healthcare apps. I turn messy',
      'research into simple flows, and I work closely with engineers until the product ships.',
      '',
      '## Experience',
      'Senior Product Designer, Souqly (online marketplace), Dubai - Mar 2023 to present',
      '- Led the redesign of search and filters; zero-result searches fell from 15% to 4%.',
      '- Redesigned mobile checkout; conversion rose from 1.9% to 2.6% in two quarters.',
      '- Built and maintained the Figma design system used by 4 product squads.',
      '',
      'Product Designer, MedLink Clinics, Bengaluru - Jun 2020 to Feb 2023',
      '- Designed appointment booking and lab-report screens for a 40-clinic patient app (1.1M users).',
      '- Ran 60+ patient interviews; added reminders that cut no-shows by 30%.',
      '',
      'UI Designer, Studio Kite (design agency), Bengaluru - Jul 2018 to May 2020',
      '- Designed websites and apps for 15 clients across retail, food and education.',
      '',
      '## Education',
      'B.Des. in Interaction Design, Srishti Institute of Art, Design and Technology, 2018',
      '',
      '## Skills',
      'User research, interaction design, prototyping, design systems, usability testing, accessibility (WCAG 2.2)',
      'Tools: Figma, FigJam, Maze, Miro, basic HTML/CSS',
      '',
      '## Languages',
      'English (fluent), Hindi (fluent), Malayalam (native), Urdu (conversational)',
    ],
  },
};

for (const [name, spec] of Object.entries(pdfs)) await writePdf(name, spec);
