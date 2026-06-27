import type { AxiosRequestConfig } from 'axios';

export const TARGET_URL = 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml';
export const FORM_ID = 'listarDetalleInfraccionRAAForm';
export const TABLE_ID = `${FORM_ID}:dt`;
export const TABLE_CONTAINER_ID = `${FORM_ID}:pgLista`;
export const SEARCH_BUTTON_ID = `${FORM_ID}:btnBuscar`;
export const VIEW_STATE_UPDATE_ID = 'j_id1:javax.faces.ViewState:0';

export interface ScraperOptions {
  readonly mode: 'scrape' | 'retry';
  readonly maxPages?: number;
  readonly outputDir: string;
  readonly delayMinMs: number;
  readonly delayMaxMs: number;
  readonly baseBackoffMs: number;
  readonly maxRetries: number;
}

export interface PaginationInfo {
  readonly currentPage: number;
  readonly totalPages: number;
  readonly totalRecords: number;
  readonly rowsPerPage: number;
}

export interface OefaRecord {
  readonly sequenceNumber: number | null;
  readonly expediente: string;
  readonly administrado: string;
  readonly unidadFiscalizable: string;
  readonly sector: string;
  readonly resolucionApelacion: string;
  readonly uuid: string | null;
  readonly downloadCommand: string | null;
  readonly rawCells: readonly string[];
}

export interface ScrapedPage {
  readonly pageNumber: number;
  readonly scrapedAt: string;
  readonly pagination: PaginationInfo;
  readonly records: readonly OefaRecord[];
}

export interface AjaxParseResult {
  readonly viewState: string;
  readonly tableHtml: string;
}

export interface PageParseResult {
  readonly records: readonly OefaRecord[];
  readonly pagination: PaginationInfo;
}

export interface ProgressState {
  readonly nextPage: number;
  readonly totalPages?: number;
  readonly totalRecords?: number;
  readonly updatedAt?: string;
}

export interface FailedDownload {
  readonly uuid: string;
  readonly identifier: string;
  readonly pageNumber: number;
  readonly errorReason: string;
  readonly timestamp: string;
}

export interface PdfDownloadTarget {
  readonly uuid: string;
  readonly identifier: string;
  readonly pageNumber: number;
  readonly command: string;
}

export interface PdfDownloadResult {
  readonly filename: string;
  readonly bytes: Buffer;
}

export interface RetryableRequestConfig extends AxiosRequestConfig {
  __retryCount?: number;
}
