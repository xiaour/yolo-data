import { presentationValueForColumn } from './resultPresentation.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function columnLetter(index) {
  let value = Number(index) + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function columnKey(column) {
  return String(column?.bizName ?? column?.nameEn ?? column?.name ?? '').trim();
}

function validatePresentation(columns, rows) {
  for (const column of columns ?? []) {
    if (!column?.presentationType) {
      continue;
    }
    const label = String(column.name ?? column.childName ?? '');
    if (
      column.presentationType === 'percent'
      && !/%/.test(`${label} ${column.numberFormat ?? ''}`)
    ) {
      throw new Error(`percentage column requires percent format: ${label}`);
    }
    if (
      column.presentationType === 'amount'
      && column.unit
      && !label.includes(String(column.unit))
    ) {
      throw new Error(`amount column requires unit header: ${label}`);
    }
    for (const row of rows ?? []) {
      const value = row?.[columnKey(column)];
      if (value === null || value === undefined || value === '') {
        continue;
      }
      if (!Number.isFinite(Number(presentationValueForColumn(value, column)))) {
        throw new Error(`non-numeric presentation value in ${label}`);
      }
    }
  }
}

function styleForColumn(column, stylePlan) {
  const numberFormat = String(column?.numberFormat ?? '');
  const formattedStyle = stylePlan.styleIndexByFormat.get(numberFormat);
  if (column?.presentationType && formattedStyle !== undefined) {
    return formattedStyle;
  }
  return String(column?.showType ?? column?.type ?? '').toUpperCase() === 'NUMBER'
    || String(column?.type ?? '').toUpperCase() === 'DECIMAL'
    ? stylePlan.numericStyleIndex
    : 2;
}

function columnWidth(column) {
  const label = String(column?.name ?? columnKey(column));
  return Math.max(12, Math.min(28, label.length * 2 + 4));
}

function cellXml(reference, value, style, textValue = false) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  if (textValue || typeof value === 'boolean' || Number.isNaN(Number(value))) {
    return `<c r="${reference}" s="${style}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  }
  return `<c r="${reference}" s="${style}"><v>${Number(value)}</v></c>`;
}

function buildHeader({ columns }) {
  const grouped = columns.some((column) => column?.parentName);
  if (!grouped) {
    return {
      headerRows: 1,
      rowsXml: [`
        <row r="1" ht="24" customHeight="1">
          ${columns.map((column, index) => cellXml(
            `${columnLetter(index)}1`,
            column.name ?? columnKey(column),
            1,
            true,
          )).join('')}
        </row>
      `],
      merges: [],
    };
  }

  const firstRow = [];
  const secondRow = [];
  const merges = [];
  let index = 0;
  while (index < columns.length) {
    const column = columns[index];
    const parent = String(column?.parentName ?? '');
    if (!parent) {
      firstRow.push(cellXml(
        `${columnLetter(index)}1`,
        column.name ?? columnKey(column),
        1,
        true,
      ));
      merges.push(`${columnLetter(index)}1:${columnLetter(index)}2`);
      index += 1;
      continue;
    }
    let end = index;
    while (
      end + 1 < columns.length
      && String(columns[end + 1]?.parentName ?? '') === parent
    ) {
      end += 1;
    }
    firstRow.push(cellXml(`${columnLetter(index)}1`, parent, 1, true));
    for (let childIndex = index; childIndex <= end; childIndex += 1) {
      secondRow.push(cellXml(
        `${columnLetter(childIndex)}2`,
        columns[childIndex]?.childName ?? columns[childIndex]?.name,
        1,
        true,
      ));
    }
    if (end > index) {
      merges.push(`${columnLetter(index)}1:${columnLetter(end)}1`);
    }
    index = end + 1;
  }
  return {
    headerRows: 2,
    rowsXml: [
      `<row r="1" ht="24" customHeight="1">${firstRow.join('')}</row>`,
      `<row r="2" ht="24" customHeight="1">${secondRow.join('')}</row>`,
    ],
    merges,
  };
}

function sheetXml({ columns, rows, stylePlan }) {
  const header = buildHeader({ columns });
  const dataRows = (rows ?? []).map((row, rowIndex) => {
    const rowNumber = header.headerRows + rowIndex + 1;
    return `
      <row r="${rowNumber}">
        ${columns.map((column, columnIndex) => cellXml(
          `${columnLetter(columnIndex)}${rowNumber}`,
          presentationValueForColumn(row?.[columnKey(column)], column),
          styleForColumn(column, stylePlan),
        )).join('')}
      </row>
    `;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetViews>
        <sheetView workbookViewId="0">
          <pane ySplit="${header.headerRows}" topLeftCell="A${header.headerRows + 1}" activePane="bottomLeft" state="frozen"/>
        </sheetView>
      </sheetViews>
      <cols>
        ${columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${columnWidth(column)}" customWidth="1"/>`).join('')}
      </cols>
      <sheetData>
        ${header.rowsXml.join('')}
        ${dataRows.join('')}
      </sheetData>
      ${header.merges.length
        ? `<mergeCells count="${header.merges.length}">${header.merges.map((reference) => `<mergeCell ref="${reference}"/>`).join('')}</mergeCells>`
        : ''}
    </worksheet>`;
}

function buildStylePlan(columns = []) {
  const formats = [];
  for (const column of columns) {
    const numberFormat = String(column?.numberFormat ?? '');
    if (
      column?.presentationType
      && numberFormat
      && !formats.includes(numberFormat)
    ) {
      formats.push(numberFormat);
    }
  }
  const styleIndexByFormat = new Map(
    formats.map((format, index) => [format, 3 + index]),
  );
  const numericStyleIndex = 3 + formats.length;
  const numberFormatsXml = formats.length > 0
    ? `<numFmts count="${formats.length}">${formats.map((format, index) => (
      `<numFmt numFmtId="${164 + index}" formatCode="${escapeXml(format)}"/>`
    )).join('')}</numFmts>`
    : '';
  const customStylesXml = formats.map((_format, index) => (
    `<xf numFmtId="${164 + index}" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>`
  )).join('');
  return {
    styleIndexByFormat,
    numericStyleIndex,
    xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${numberFormatsXml}
  <fonts count="2">
    <font><sz val="10"/><name val="Arial"/></font>
    <font><b/><sz val="10"/><name val="Arial"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="${4 + formats.length}">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>
    ${customStylesXml}
    <xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
  };
}

export function createXlsxBuffer({
  sheetName = '数据',
  columns = [],
  rows = [],
} = {}) {
  validatePresentation(columns, rows);
  const normalizedSheetName = String(sheetName || '数据').slice(0, 31);
  const stylePlan = buildStylePlan(columns);
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
          <Default Extension="xml" ContentType="application/xml"/>
          <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
          <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
          <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
        </Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
        </Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets><sheet name="${escapeXml(normalizedSheetName)}" sheetId="1" r:id="rId1"/></sheets>
        </workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        </Relationships>`,
    },
    { name: 'xl/styles.xml', data: stylePlan.xml },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: sheetXml({ columns, rows, stylePlan }),
    },
  ];
  return zipEntries(files);
}
