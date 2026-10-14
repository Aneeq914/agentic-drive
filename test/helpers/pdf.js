// Test-only helper: builds real PDFs in memory with pdfkit (a devDependency), so tests can run
// PDFs through the real extractor without any PDF files being kept in the repo.
import PDFDocument from 'pdfkit';

// A large title, an optional subtitle, then one line of 11pt text per entry.
// A line starting with "## " is drawn as a bold section heading.
export function makePdf({ title, subtitle, lines = [] }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(20).text(title);
    if (subtitle) doc.fontSize(14).text(subtitle);
    doc.moveDown();
    doc.fontSize(11);
    for (const line of lines) {
      if (line.startsWith('## ')) doc.moveDown(0.5).font('Helvetica-Bold').text(line.slice(3)).font('Helvetica');
      else doc.text(line);
    }
    doc.end();
  });
}

// A one-page resume: name as the title, job title as the subtitle, contact line, then sections.
export const RESUME = {
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
    '## Skills',
    'User research, interaction design, prototyping, design systems, usability testing, accessibility (WCAG 2.2)',
    'Tools: Figma, FigJam, Maze, Miro, basic HTML/CSS',
  ],
};
