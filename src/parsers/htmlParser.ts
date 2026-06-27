import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import {
  TABLE_CONTAINER_ID,
  TABLE_ID,
  VIEW_STATE_UPDATE_ID,
  type AjaxParseResult,
  type OefaRecord,
  type PageParseResult,
  type PaginationInfo,
} from '../types';

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value.replace(/\D+/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireValue(value: string | undefined, message: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

function updateTextById($xml: cheerio.CheerioAPI, id: string): string | null {
  const match = $xml('update').filter((_, element) => $xml(element).attr('id') === id).first();
  if (match.length === 0) {
    return null;
  }
  return match.text();
}

function findTableUpdate($xml: cheerio.CheerioAPI): string {
  const preferredIds = [TABLE_CONTAINER_ID, TABLE_ID];
  for (const id of preferredIds) {
    const text = updateTextById($xml, id);
    if (text !== null && text.length > 0) {
      return text;
    }
  }

  const fallback = $xml('update')
    .toArray()
    .map((element: AnyNode) => $xml(element).text())
    .find((text: string) => text.includes(`${TABLE_ID}_data`) || text.includes('ui-datatable-data'));

  if (fallback === undefined) {
    throw new Error('Could not find table update block in JSF partial response.');
  }
  return fallback;
}

export function parseInitialViewState(initialHtml: string): string {
  const $ = cheerio.load(initialHtml);
  return requireValue($('input[name="javax.faces.ViewState"]').attr('value'), 'Initial ViewState was not found.');
}

export function parseAjaxResponse(xmlResponseData: string): AjaxParseResult {
  const $xml = cheerio.load(xmlResponseData, { xmlMode: true });
  const viewState = updateTextById($xml, VIEW_STATE_UPDATE_ID)
    ?? $xml('update')
      .filter((_, element) => ($xml(element).attr('id') ?? '').includes('javax.faces.ViewState'))
      .first()
      .text();

  if (viewState.length === 0) {
    throw new Error('Next ViewState was not found in JSF partial response.');
  }

  return {
    viewState,
    tableHtml: findTableUpdate($xml),
  };
}

function parsePagination($: cheerio.CheerioAPI, fallback?: PaginationInfo): PaginationInfo {
  const currentText = normalizeText($('.ui-paginator-current').first().text());
  const textMatch = currentText.match(/P.?gina\s+(\d+)\s+de\s+(\d+)\s+\((\d+)\s+registros?\)/i);
  if (textMatch !== null) {
    return {
      currentPage: Number.parseInt(textMatch[1] ?? '1', 10),
      totalPages: Number.parseInt(textMatch[2] ?? '1', 10),
      totalRecords: Number.parseInt(textMatch[3] ?? '0', 10),
      rowsPerPage: 10,
    };
  }

  const scriptText = $('script').toArray().map((element: AnyNode) => $(element).text()).join('\n');
  const rows = Number.parseInt(scriptText.match(/rows\s*:\s*(\d+)/)?.[1] ?? '10', 10);
  const rowCount = Number.parseInt(scriptText.match(/rowCount\s*:\s*(\d+)/)?.[1] ?? '0', 10);
  const zeroBasedPage = Number.parseInt(scriptText.match(/page\s*:\s*(\d+)/)?.[1] ?? '0', 10);

  if (rowCount > 0) {
    return {
      currentPage: zeroBasedPage + 1,
      totalPages: Math.max(1, Math.ceil(rowCount / rows)),
      totalRecords: rowCount,
      rowsPerPage: rows,
    };
  }

  const firstRowIndex = Number.parseInt($('tr[data-ri]').first().attr('data-ri') ?? '0', 10);
  const fallbackRows = fallback?.rowsPerPage ?? 10;
  return {
    currentPage: Math.floor(firstRowIndex / fallbackRows) + 1,
    totalPages: fallback?.totalPages ?? 1,
    totalRecords: fallback?.totalRecords ?? $('tr[data-ri]').length,
    rowsPerPage: fallbackRows,
  };
}

function parseUuid(onclickText: string): string | null {
  return onclickText.match(/['"]param_uuid['"]\s*:\s*['"]([^'"]+)['"]/)?.[1]
    ?? onclickText.match(/param_uuid['"]?\s*[:,]\s*['"]([^'"]+)/)?.[1]
    ?? null;
}

function parseDownloadCommand(onclickText: string): string | null {
  const objectBody = onclickText.match(/\{([^}]+)\}/)?.[1] ?? '';
  const pairs = [...objectBody.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)];
  const command = pairs.find((pair: RegExpMatchArray) => pair[1] !== 'param_uuid')?.[1];
  return command ?? null;
}

export function parseTableHtml(tableHtmlContainer: string, fallbackPagination?: PaginationInfo): PageParseResult {
  const trimmedHtml = tableHtmlContainer.trim();
  const htmlForParsing = trimmedHtml.startsWith('<tr') ? `<table><tbody>${trimmedHtml}</tbody></table>` : tableHtmlContainer;
  const $ = cheerio.load(htmlForParsing);
  const pagination = parsePagination($, fallbackPagination);
  const records: OefaRecord[] = [];
  const bodyRows = $(`tbody[id="${TABLE_ID}_data"] > tr`);
  const rows = bodyRows.length > 0 ? bodyRows : $('tr[data-ri]');

  rows.each((_, row) => {
    const cells = $(row).children('td').toArray().map((cell: AnyNode) => normalizeText($(cell).text()));
    if (cells.length === 0 || $(row).hasClass('ui-datatable-empty-message')) {
      return;
    }

    const onclickText = $(row).find('a[onclick*="param_uuid"]').first().attr('onclick') ?? '';
    records.push({
      sequenceNumber: parsePositiveInt(cells[0]),
      expediente: cells[1] ?? '',
      administrado: cells[2] ?? '',
      unidadFiscalizable: cells[3] ?? '',
      sector: cells[4] ?? '',
      resolucionApelacion: cells[5] ?? '',
      uuid: parseUuid(onclickText),
      downloadCommand: parseDownloadCommand(onclickText),
      rawCells: cells,
    });
  });

  return { records, pagination };
}

export function extractFilenameFromDisposition(disposition: string | undefined, uuid: string): string {
  const fallback = `${uuid}.pdf`;
  if (disposition === undefined || disposition.length === 0) {
    return fallback;
  }

  const utf8Match = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1] !== undefined) {
    return decodeURIComponent(utf8Match[1]);
  }

  return disposition.match(/filename="?([^";]+)"?/i)?.[1]?.trim() || fallback;
}
