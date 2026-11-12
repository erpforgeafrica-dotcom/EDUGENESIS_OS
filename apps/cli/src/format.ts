/**
 * Console formatting helpers. Plain text only — no colour escapes, so the
 * output stays readable in a redirected log and in a CI transcript.
 */

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface CheckRow {
  /** Stable machine-readable identifier, e.g. `node.version`. */
  readonly id: string;
  /** Human-readable label. */
  readonly label: string;
  /** Outcome. */
  readonly status: CheckStatus;
  /** Detail shown next to the outcome. */
  readonly detail: string;
}

/** Render a fixed-width table. */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    rows.reduce((width, row) => Math.max(width, (row[column] ?? '').length), header.length),
  );
  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (cell ?? '').padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();

  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  return [renderRow(headers), separator, ...rows.map(renderRow)].join('\n');
}

/** Render the doctor / selftest check table. */
export function renderChecks(rows: readonly CheckRow[]): string {
  return renderTable(
    ['STATUS', 'CHECK', 'DETAIL'],
    rows.map((row) => [row.status, row.id, row.detail]),
  );
}

/** Count rows by status. */
export function countByStatus(rows: readonly CheckRow[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}
