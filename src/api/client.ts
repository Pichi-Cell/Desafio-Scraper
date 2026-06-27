import axios, { AxiosError, AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { CookieJar } from 'tough-cookie';
import {
  FORM_ID,
  SEARCH_BUTTON_ID,
  TABLE_ID,
  TARGET_URL,
  TABLE_CONTAINER_ID,
  type PdfDownloadResult,
  type PdfDownloadTarget,
} from '../types';
import { extractFilenameFromDisposition } from '../parsers/htmlParser';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function calculateBackoffDelayMs(baseBackoffMs: number, retryCount: number): number {
  return baseBackoffMs * (2 ** retryCount);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function appendFormFields(params: URLSearchParams): void {
  params.set(FORM_ID, FORM_ID);
  params.set(`${FORM_ID}:txtNroexp`, '');
  params.set(`${FORM_ID}:j_idt21`, '');
  params.set(`${FORM_ID}:j_idt25`, '');
  params.set(`${FORM_ID}:idsector`, '');
  params.set(`${FORM_ID}:j_idt34`, '');
  params.set(`${TABLE_ID}_scrollState`, '0,0');
}

interface StatefulRequestConfig extends InternalAxiosRequestConfig {
  __retryCount?: number;
}

export class OefaHttpClient {
  private readonly axiosClient: AxiosInstance;
  private readonly cookieJar = new CookieJar();
  private readonly delayMinMs: number;
  private readonly delayMaxMs: number;

  public constructor(options: { readonly delayMinMs: number; readonly delayMaxMs: number; readonly baseBackoffMs: number; readonly maxRetries: number }) {
    this.delayMinMs = options.delayMinMs;
    this.delayMaxMs = options.delayMaxMs;
    this.axiosClient = axios.create({
      baseURL: TARGET_URL,
      timeout: 120_000,
      maxRedirects: 5,
      validateStatus: (status: number) => status >= 200 && status < 300,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OEFA-Stateful-Scraper/1.0; +https://publico.oefa.gob.pe)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    this.axiosClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
      const requestUrl = new URL(config.url ?? TARGET_URL, config.baseURL ?? TARGET_URL).toString();
      const cookieHeader = await this.cookieJar.getCookieString(requestUrl);
      if (cookieHeader.length > 0) {
        config.headers = AxiosHeaders.from(config.headers);
        config.headers.set('Cookie', cookieHeader);
      }
      return config;
    });

    this.axiosClient.interceptors.response.use(
      async (response: AxiosResponse) => {
        await this.captureCookies(response);
        return response;
      },
      async (error: AxiosError) => {
        if (error.response !== undefined) {
          await this.captureCookies(error.response);
        }

        const status = error.response?.status;
        const config = error.config as StatefulRequestConfig | undefined;
        if (status === 429 && config !== undefined) {
          const retryCount = config.__retryCount ?? 0;
          if (retryCount < options.maxRetries) {
            config.__retryCount = retryCount + 1;
            const delayMs = calculateBackoffDelayMs(options.baseBackoffMs, retryCount);
            console.warn(`HTTP 429 received. Retrying in ${delayMs}ms (${retryCount + 1}/${options.maxRetries}).`);
            await sleep(delayMs);
            return this.axiosClient.request(config);
          }
          return Promise.reject(new Error('HTTP Status 429 - Retries Exhausted'));
        }

        return Promise.reject(error);
      },
    );
  }

  private async throttle(): Promise<void> {
    await sleep(randomInt(this.delayMinMs, this.delayMaxMs));
  }

  private async captureCookies(response: AxiosResponse): Promise<void> {
    const setCookie = response.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
    await Promise.all(cookies.map((cookie: string) => this.cookieJar.setCookie(cookie, TARGET_URL)));
  }

  public async getInitialHtml(): Promise<string> {
    await this.throttle();
    const response = await this.axiosClient.get<string>('', { responseType: 'text' });
    return response.data;
  }

  public async search(viewState: string): Promise<string> {
    const params = new URLSearchParams();
    params.set('javax.faces.partial.ajax', 'true');
    params.set('javax.faces.source', SEARCH_BUTTON_ID);
    params.set('javax.faces.partial.execute', `${SEARCH_BUTTON_ID} ${FORM_ID}`);
    params.set('javax.faces.partial.render', `${TABLE_CONTAINER_ID} ${FORM_ID}:txtNroexp`);
    params.set(SEARCH_BUTTON_ID, SEARCH_BUTTON_ID);
    appendFormFields(params);
    params.set('javax.faces.ViewState', viewState);
    return this.postAjax(params);
  }

  public async paginate(viewState: string, pageNumber: number, rowsPerPage: number): Promise<string> {
    const first = Math.max(0, (pageNumber - 1) * rowsPerPage);
    const params = new URLSearchParams();
    params.set('javax.faces.partial.ajax', 'true');
    params.set('javax.faces.source', TABLE_ID);
    params.set('javax.faces.partial.execute', TABLE_ID);
    params.set('javax.faces.partial.render', TABLE_ID);
    params.set(TABLE_ID, TABLE_ID);
    params.set(`${TABLE_ID}_pagination`, 'true');
    params.set(`${TABLE_ID}_first`, String(first));
    params.set(`${TABLE_ID}_rows`, String(rowsPerPage));
    params.set(`${TABLE_ID}_skipChildren`, 'true');
    params.set(`${TABLE_ID}_encodeFeature`, 'true');
    appendFormFields(params);
    params.set('javax.faces.ViewState', viewState);
    return this.postAjax(params);
  }

  private async postAjax(params: URLSearchParams): Promise<string> {
    await this.throttle();
    const response = await this.axiosClient.post<string>('', params.toString(), {
      responseType: 'text',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Faces-Request': 'partial/ajax',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/xml, text/xml, */*; q=0.01',
      },
    });
    return response.data;
  }

  public async downloadPdf(viewState: string, target: PdfDownloadTarget): Promise<PdfDownloadResult> {
    const params = new URLSearchParams();
    appendFormFields(params);
    params.set(target.command, target.command);
    params.set('param_uuid', target.uuid);
    params.set('javax.faces.ViewState', viewState);

    await this.throttle();
    const response = await this.axiosClient.post<ArrayBuffer>('', params.toString(), {
      responseType: 'arraybuffer',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/pdf,application/octet-stream,*/*',
      },
    });

    const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
    const bytes = Buffer.from(response.data);
    if (!contentType.includes('pdf') && !contentType.includes('octet-stream') && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error(`Unexpected PDF response content-type: ${contentType || 'unknown'}`);
    }

    return {
      filename: extractFilenameFromDisposition(response.headers['content-disposition'] as string | undefined, target.uuid),
      bytes,
    };
  }
}
