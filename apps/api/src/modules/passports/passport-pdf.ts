import type { PassportDocument } from '@gridflex/contracts';

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 44;
const CONTENT_WIDTH = PAGE_WIDTH - (MARGIN * 2);
const FOOTER_TOP = 48;

type Font = 'F1' | 'F2' | 'F3';
type Rgb = readonly [number, number, number];
type PdfPage = { commands: string[] };

const INK: Rgb = [0.08, 0.1, 0.14];
const MUTED: Rgb = [0.36, 0.39, 0.44];
const RULE: Rgb = [0.78, 0.8, 0.84];
const PAPER: Rgb = [0.965, 0.97, 0.98];
const WHITE: Rgb = [1, 1, 1];
const AMBER: Rgb = [0.95, 0.66, 0.14];
const GREEN: Rgb = [0.1, 0.48, 0.3];

/**
 * Builds a deterministic, dependency-free PDF presentation of a Passport.
 * The canonical JSON remains the hash input; this report is deliberately
 * labelled as a readable derivative so PDF renderer differences cannot alter
 * the independently verifiable evidence digest.
 */
export function renderPassportPdf(
  passportSha256: string,
  document: PassportDocument,
): Buffer {
  const report = new PassportPdf(document, passportSha256);
  report.compose();
  return report.toBuffer();
}

class PassportPdf {
  private readonly pages: PdfPage[] = [];
  private y = 0;

  constructor(
    private readonly document: PassportDocument,
    private readonly passportSha256: string,
  ) {}

  compose(): void {
    this.newPage(true);
    this.coverHeader();
    this.metricStrip();

    this.section('Facility and issuance');
    this.row('Facility', this.document.facility.name);
    this.row(
      'Region / market',
      [this.document.facility.region, this.document.facility.market]
        .filter(Boolean)
        .join(' / ') || 'Not recorded',
    );
    this.row('Timezone', this.document.facility.timezone);
    this.row('Issued at (UTC)', this.document.issued_at);
    this.row('Methodology', this.document.methodology_version);
    this.row('Envelope version', String(this.document.envelope.version));

    this.section('Safety boundary');
    this.row('Minimum safe load', `${this.document.safety.minimum_safe_load_kw} kW`);
    this.row('Maximum curtailment', `${this.document.safety.maximum_curtailment_kw} kW`);
    this.row('Maximum ramp', `${this.document.safety.maximum_ramp_kw_per_min} kW/min`);
    this.row('Maximum duration', `${this.document.safety.maximum_duration_min} min`);
    this.row('Constraint version', String(this.document.safety.constraints_version));
    this.row(
      'Excluded workloads',
      this.document.safety.excluded_workloads.join(', ') || 'None recorded',
    );

    this.section('Mechanism provenance');
    for (const mechanism of this.document.envelope.mechanisms) {
      this.subheading(`${mechanism.mechanism_code} / ${mechanism.provenance}`);
      this.row('Mechanism', mechanism.mechanism_name);
      this.row('Reducible capacity', `${mechanism.reducible_kw} kW`);
      this.row(
        'Response / ramp',
        `${mechanism.response_time_seconds}s / ${mechanism.ramp_kw_per_min} kW/min`,
      );
      this.row('Sustainable duration', `${mechanism.duration_min} min`);
      this.row('Confidence', `${percentage(mechanism.confidence_score)}%`);
      if (mechanism.notes) this.row('Notes', mechanism.notes);
    }

    this.section('Telemetry quality');
    this.row('Completeness', `${percentage(this.document.data_quality.completeness)}%`);
    this.row(
      'Evidence window',
      `${this.document.data_quality.window_start} to ${this.document.data_quality.window_end}`,
    );
    this.row(
      'Data classification',
      this.document.data_quality.contains_simulated_data
        ? 'Contains simulated data'
        : 'No simulated data recorded in this Passport',
    );
    for (const connector of this.document.data_quality.connector_provenance) {
      this.row(
        `Source: ${connector.connector_type}`,
        `${connector.name}; last success ${connector.last_success_at ?? 'not recorded'}`,
      );
    }

    this.section('Drill history');
    if (this.document.drill_history.length === 0) {
      this.paragraph('No completed drill is associated with this Passport.');
    }
    for (const drill of this.document.drill_history) {
      this.subheading(`${drill.name} / ${drill.status}${drill.simulation_mode ? ' / SIMULATED' : ''}`);
      this.row('Started', drill.started_at ?? 'Not recorded');
      this.row('Requested reduction', `${drill.requested_reduction_kw} kW`);
      this.row(
        'Delivered energy',
        drill.delivered_energy_wh === null
          ? 'Not measured'
          : `${(Number(drill.delivered_energy_wh) / 1000).toFixed(3)} kWh`,
      );
      this.row(
        'Performance',
        drill.performance_bps === null
          ? 'Not measured'
          : `${(drill.performance_bps / 100).toFixed(2)}%`,
      );
    }

    this.section('Limitations');
    for (const limitation of this.document.limitations) {
      this.bullet(limitation);
    }
    if (this.document.notes) {
      this.subheading('Issuer notes');
      this.paragraph(this.document.notes);
    }

    this.section('Independent verification');
    this.paragraph(
      'This PDF is a readable derivative. Independently verify the canonical JSON document and evidence bundle; do not hash the PDF bytes.',
    );
    this.row('Passport SHA-256', spacedDigest(this.passportSha256), true);
    this.row('Evidence SHA-256', spacedDigest(this.document.evidence_sha256), true);
    this.row('Canonical schema', 'gridflex-canonical-1');
    this.row('Passport ID', this.document.id, true);
    this.row('Evidence bundle ID', this.document.evidence_bundle_id, true);

    this.addFooters();
  }

  toBuffer(): Buffer {
    return buildPdf(this.pages);
  }

  private newPage(first = false): void {
    this.pages.push({ commands: [] });
    this.y = PAGE_HEIGHT - MARGIN;
    if (!first) {
      this.text('GridFlex', MARGIN, this.y, 10, 'F2', INK);
      this.text('FLEXIBILITY PASSPORT', MARGIN + 61, this.y, 8, 'F3', MUTED);
      this.text(
        `v${this.document.version} / ${this.document.facility.name}`,
        PAGE_WIDTH - MARGIN,
        this.y,
        8,
        'F1',
        MUTED,
        'right',
      );
      this.line(MARGIN, this.y - 12, PAGE_WIDTH - MARGIN, this.y - 12, RULE);
      this.y -= 34;
    }
  }

  private coverHeader(): void {
    this.fillRect(0, PAGE_HEIGHT - 126, PAGE_WIDTH, 126, INK);
    this.text('GridFlex', MARGIN, PAGE_HEIGHT - 44, 11, 'F2', WHITE);
    this.text('FLEXIBILITY PASSPORT', MARGIN, PAGE_HEIGHT - 79, 25, 'F2', WHITE);
    this.text(
      `${this.document.facility.name} / version ${this.document.version}`,
      MARGIN,
      PAGE_HEIGHT - 103,
      10,
      'F1',
      [0.82, 0.84, 0.88],
    );

    const simulated = this.document.data_quality.contains_simulated_data;
    const badgeWidth = 154;
    this.fillRect(
      PAGE_WIDTH - MARGIN - badgeWidth,
      PAGE_HEIGHT - 57,
      badgeWidth,
      22,
      simulated ? AMBER : GREEN,
    );
    this.text(
      simulated ? 'SIMULATED PILOT EVIDENCE' : 'ISSUED EVIDENCE',
      PAGE_WIDTH - MARGIN - (badgeWidth / 2),
      PAGE_HEIGHT - 50,
      7.5,
      'F2',
      simulated ? INK : WHITE,
      'center',
    );
    this.y = PAGE_HEIGHT - 150;
  }

  private metricStrip(): void {
    const gap = 8;
    const cardWidth = (CONTENT_WIDTH - (gap * 3)) / 4;
    const top = this.y;
    const metrics = [
      ['REDUCIBLE', `${this.document.envelope.total_reducible_kw} kW`],
      ['RESPONSE', `${this.document.envelope.response_time_seconds}s`],
      ['DURATION', `${this.document.envelope.sustainable_duration_min} min`],
      ['CONFIDENCE', `${percentage(this.document.envelope.confidence_score)}%`],
    ] as const;
    metrics.forEach(([label, value], index) => {
      const x = MARGIN + (index * (cardWidth + gap));
      this.fillRect(x, top - 62, cardWidth, 62, PAPER);
      this.strokeRect(x, top - 62, cardWidth, 62, RULE);
      this.text(label, x + 10, top - 19, 7, 'F3', MUTED);
      this.text(value, x + 10, top - 44, 14, 'F2', INK);
    });
    this.y -= 78;
  }

  private section(title: string): void {
    this.ensure(38);
    this.y -= 7;
    this.line(MARGIN, this.y, PAGE_WIDTH - MARGIN, this.y, RULE);
    this.text(title.toUpperCase(), MARGIN, this.y - 18, 8, 'F2', INK);
    this.y -= 32;
  }

  private subheading(title: string): void {
    const lines = wrapText(title, 72);
    const height = (lines.length * 12) + 10;
    this.ensure(height);
    this.fillRect(MARGIN, this.y - height + 4, CONTENT_WIDTH, height, PAPER);
    lines.forEach((line, index) => {
      this.text(line, MARGIN + 8, this.y - 11 - (index * 12), 8.5, 'F2', INK);
    });
    this.y -= height + 3;
  }

  private row(label: string, value: string, monospace = false): void {
    const labelLines = wrapText(label, 25);
    const valueLines = wrapText(value, monospace ? 58 : 72);
    const lineCount = Math.max(labelLines.length, valueLines.length);
    const height = (lineCount * 11.5) + 7;
    this.ensure(height);
    labelLines.forEach((line, index) => {
      this.text(line, MARGIN, this.y - 10 - (index * 11.5), 8, 'F2', MUTED);
    });
    valueLines.forEach((line, index) => {
      this.text(
        line,
        MARGIN + 154,
        this.y - 10 - (index * 11.5),
        monospace ? 7.5 : 8.5,
        monospace ? 'F3' : 'F1',
        INK,
      );
    });
    this.line(MARGIN, this.y - height + 2, PAGE_WIDTH - MARGIN, this.y - height + 2, [0.9, 0.91, 0.93]);
    this.y -= height;
  }

  private paragraph(value: string): void {
    const lines = wrapText(value, 88);
    const height = (lines.length * 12.5) + 7;
    this.ensure(height);
    lines.forEach((line, index) => {
      this.text(line, MARGIN, this.y - 10 - (index * 12.5), 9, 'F1', INK);
    });
    this.y -= height;
  }

  private bullet(value: string): void {
    const lines = wrapText(value, 82);
    const height = (lines.length * 12.5) + 7;
    this.ensure(height);
    this.fillRect(MARGIN, this.y - 9, 4, 4, AMBER);
    lines.forEach((line, index) => {
      this.text(line, MARGIN + 14, this.y - 10 - (index * 12.5), 9, 'F1', INK);
    });
    this.y -= height;
  }

  private ensure(height: number): void {
    if (this.y - height < FOOTER_TOP + 18) this.newPage();
  }

  private addFooters(): void {
    const total = this.pages.length;
    this.pages.forEach((page, index) => {
      page.commands.push(lineCommand(MARGIN, 37, PAGE_WIDTH - MARGIN, 37, RULE));
      page.commands.push(
        textCommand(
          'Readable derivative - verify canonical JSON hashes',
          MARGIN,
          20,
          7,
          'F1',
          MUTED,
        ),
      );
      page.commands.push(
        textCommand(
          `Page ${index + 1} of ${total}`,
          PAGE_WIDTH - MARGIN,
          20,
          7,
          'F3',
          MUTED,
          'right',
        ),
      );
    });
  }

  private get page(): PdfPage {
    return this.pages[this.pages.length - 1]!;
  }

  private text(
    value: string,
    x: number,
    y: number,
    size: number,
    font: Font,
    color: Rgb,
    align: 'left' | 'center' | 'right' = 'left',
  ): void {
    this.page.commands.push(textCommand(value, x, y, size, font, color, align));
  }

  private fillRect(x: number, y: number, width: number, height: number, color: Rgb): void {
    this.page.commands.push(`${rgb(color)} rg ${n(x)} ${n(y)} ${n(width)} ${n(height)} re f`);
  }

  private strokeRect(x: number, y: number, width: number, height: number, color: Rgb): void {
    this.page.commands.push(`${rgb(color)} RG 0.6 w ${n(x)} ${n(y)} ${n(width)} ${n(height)} re S`);
  }

  private line(x1: number, y1: number, x2: number, y2: number, color: Rgb): void {
    this.page.commands.push(lineCommand(x1, y1, x2, y2, color));
  }
}

function textCommand(
  value: string,
  x: number,
  y: number,
  size: number,
  font: Font,
  color: Rgb,
  align: 'left' | 'center' | 'right' = 'left',
): string {
  const safe = pdfText(value);
  const estimatedWidth = safe.length * size * (font === 'F3' ? 0.6 : 0.5);
  const alignedX = align === 'right' ? x - estimatedWidth : align === 'center' ? x - (estimatedWidth / 2) : x;
  return `BT ${rgb(color)} rg /${font} ${n(size)} Tf 1 0 0 1 ${n(alignedX)} ${n(y)} Tm (${escapePdfString(safe)}) Tj ET`;
}

function lineCommand(x1: number, y1: number, x2: number, y2: number, color: Rgb): string {
  return `${rgb(color)} RG 0.6 w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`;
}

function buildPdf(pages: PdfPage[]): Buffer {
  const pageObjectIds = pages.map((_, index) => 6 + (index * 2));
  const objects = new Map<number, Buffer>();
  objects.set(1, binary('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(
    2,
    binary(`<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] >>`),
  );
  objects.set(3, binary('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  objects.set(4, binary('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  objects.set(5, binary('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'));

  pages.forEach((page, index) => {
    const pageId = pageObjectIds[index]!;
    const contentId = pageId + 1;
    const stream = binary(`${page.commands.join('\n')}\n`);
    objects.set(
      pageId,
      binary(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(PAGE_WIDTH)} ${n(PAGE_HEIGHT)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    objects.set(
      contentId,
      Buffer.concat([
        binary(`<< /Length ${stream.length} >>\nstream\n`),
        stream,
        binary('endstream'),
      ]),
    );
  });

  const maxObjectId = Math.max(...objects.keys());
  const chunks: Buffer[] = [binary('%PDF-1.4\n%GridFlex\n')];
  const offsets = new Array<number>(maxObjectId + 1).fill(0);
  let offset = chunks[0]!.length;
  for (let id = 1; id <= maxObjectId; id += 1) {
    const body = objects.get(id);
    if (!body) throw new Error(`Missing PDF object ${id}`);
    offsets[id] = offset;
    const object = Buffer.concat([
      binary(`${id} 0 obj\n`),
      body,
      binary('\nendobj\n'),
    ]);
    chunks.push(object);
    offset += object.length;
  }

  const xrefOffset = offset;
  const xref = [
    'xref',
    `0 ${maxObjectId + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((entry) => `${String(entry).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${maxObjectId + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(binary(xref));
  return Buffer.concat(chunks);
}

function wrapText(value: string, maximumCharacters: number): string[] {
  const normalized = pdfText(value).trim();
  if (!normalized) return ['-'];
  const tokens = normalized.split(/\s+/).flatMap((token) => {
    if (token.length <= maximumCharacters) return [token];
    const pieces: string[] = [];
    for (let index = 0; index < token.length; index += maximumCharacters) {
      pieces.push(token.slice(index, index + maximumCharacters));
    }
    return pieces;
  });
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    const candidate = current ? `${current} ${token}` : token;
    if (candidate.length <= maximumCharacters) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = token;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function spacedDigest(value: string): string {
  return value.match(/.{1,16}/g)?.join(' ') ?? value;
}

function percentage(value: string): string {
  return (Number(value) * 100).toFixed(1);
}

function pdfText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e]/g, '?');
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function rgb(value: Rgb): string {
  return value.map(n).join(' ');
}

function n(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function binary(value: string): Buffer {
  return Buffer.from(value, 'binary');
}
