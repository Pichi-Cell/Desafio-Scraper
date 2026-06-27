import path from 'node:path';
import { OefaHttpClient } from './api/client';
import { parseAjaxResponse, parseInitialViewState, parseTableHtml } from './parsers/htmlParser';
import {
  type FailedDownload,
  type OefaRecord,
  type PageParseResult,
  type PdfDownloadTarget,
  type ScrapedPage,
  type ScraperOptions,
} from './types';
import {
  appendScrapedPage,
  createOutputPaths,
  deleteProgress,
  ensureDataFile,
  ensureOutput,
  readFailedDownloads,
  readProgress,
  recordFailedDownload,
  resetDataFile,
  writeFailedDownloads,
  writePdf,
  writeProgress,
} from './utils/fileSystem';

function parseArgs(argv: readonly string[]): ScraperOptions {
  const getValue = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    return argv.find((arg: string) => arg.startsWith(prefix))?.slice(prefix.length);
  };

  const modeValue = getValue('mode');
  const maxPagesValue = getValue('max-pages');
  const outputDir = getValue('output-dir') ?? 'output';
  const delayMinMs = Number.parseInt(getValue('delay-min-ms') ?? '1000', 10);
  const delayMaxMs = Number.parseInt(getValue('delay-max-ms') ?? '2000', 10);
  const baseBackoffMs = Number.parseInt(getValue('base-backoff-ms') ?? '1500', 10);
  const maxRetries = Number.parseInt(getValue('max-retries') ?? '5', 10);

  return {
    mode: modeValue === 'retry' ? 'retry' : 'scrape',
    ...(maxPagesValue !== undefined ? { maxPages: Number.parseInt(maxPagesValue, 10) } : {}),
    outputDir,
    delayMinMs,
    delayMaxMs,
    baseBackoffMs,
    maxRetries,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function identifierFor(record: OefaRecord): string {
  return record.resolucionApelacion || record.expediente || record.uuid || 'unknown';
}

function toDownloadTarget(record: OefaRecord, pageNumber: number): PdfDownloadTarget | null {
  if (record.uuid === null || record.downloadCommand === null) {
    return null;
  }
  return {
    uuid: record.uuid,
    identifier: identifierFor(record),
    pageNumber,
    command: record.downloadCommand,
  };
}

async function bootstrapSearch(client: OefaHttpClient): Promise<{ viewState: string; page: PageParseResult }> {
  const initialHtml = await client.getInitialHtml();
  let viewState = parseInitialViewState(initialHtml);
  const searchXml = await client.search(viewState);
  const searchResult = parseAjaxResponse(searchXml);
  viewState = searchResult.viewState;
  return { viewState, page: parseTableHtml(searchResult.tableHtml) };
}

async function navigateToPage(client: OefaHttpClient, viewState: string, pageNumber: number, previousPage: PageParseResult): Promise<{ viewState: string; page: PageParseResult }> {
  if (pageNumber <= 1) {
    throw new Error('navigateToPage should only be called for pageNumber > 1.');
  }
  const pageXml = await client.paginate(viewState, pageNumber, previousPage.pagination.rowsPerPage);
  const pageResult = parseAjaxResponse(pageXml);
  return { viewState: pageResult.viewState, page: parseTableHtml(pageResult.tableHtml, previousPage.pagination) };
}

async function downloadTarget(client: OefaHttpClient, viewState: string, target: PdfDownloadTarget, paths: ReturnType<typeof createOutputPaths>): Promise<void> {
  const result = await client.downloadPdf(viewState, target);
  const outputPath = await writePdf(paths.pdfs, result.filename, result.bytes);
  console.log(`    PDF saved: ${path.relative(process.cwd(), outputPath)}`);
}

async function handleDownloadFailure(paths: ReturnType<typeof createOutputPaths>, target: PdfDownloadTarget, reason: string): Promise<void> {
  const failure: FailedDownload = {
    uuid: target.uuid,
    identifier: target.identifier,
    pageNumber: target.pageNumber,
    errorReason: reason,
    timestamp: new Date().toISOString(),
  };
  await recordFailedDownload(paths.failed, failure);
}

async function downloadPagePdfs(client: OefaHttpClient, viewState: string, pageNumber: number, records: readonly OefaRecord[], paths: ReturnType<typeof createOutputPaths>): Promise<void> {
  for (const record of records) {
    const target = toDownloadTarget(record, pageNumber);
    if (target === null) {
      console.warn(`    Missing PDF metadata for row ${record.sequenceNumber ?? 'unknown'}; skipping.`);
      continue;
    }

    try {
      await downloadTarget(client, viewState, target, paths);
    } catch (error: unknown) {
      const reason = errorMessage(error);
      console.warn(`    PDF failed (${target.uuid}): ${reason}`);
      await handleDownloadFailure(paths, target, reason);
    }
  }
}

async function runScrape(options: ScraperOptions): Promise<void> {
  const paths = createOutputPaths(options.outputDir);
  await ensureOutput(paths);

  const progress = await readProgress(paths.progress);
  if (progress === null) {
    await resetDataFile(paths.data);
  } else {
    await ensureDataFile(paths.data);
  }

  const client = new OefaHttpClient(options);
  const startPage = progress?.nextPage ?? 1;
  console.log(`Starting scrape at page boundary ${startPage}.`);

  let { viewState, page } = await bootstrapSearch(client);
  const totalPages = page.pagination.totalPages;
  const stopPage = Math.min(totalPages, options.maxPages !== undefined ? startPage + options.maxPages - 1 : totalPages);

  if (startPage > 1) {
    const navigated = await navigateToPage(client, viewState, startPage, page);
    viewState = navigated.viewState;
    page = navigated.page;
  }

  for (let pageNumber = startPage; pageNumber <= stopPage; pageNumber += 1) {
    if (page.pagination.currentPage !== pageNumber && pageNumber > 1) {
      const navigated = await navigateToPage(client, viewState, pageNumber, page);
      viewState = navigated.viewState;
      page = navigated.page;
    }

    console.log(`Page ${pageNumber}/${page.pagination.totalPages}: ${page.records.length} records.`);
    const scrapedPage: ScrapedPage = {
      pageNumber,
      scrapedAt: new Date().toISOString(),
      pagination: page.pagination,
      records: page.records,
    };
    await downloadPagePdfs(client, viewState, pageNumber, page.records, paths);
    await appendScrapedPage(paths.data, scrapedPage);
    await writeProgress(paths.progress, {
      nextPage: pageNumber + 1,
      totalPages: page.pagination.totalPages,
      totalRecords: page.pagination.totalRecords,
    });

    if (pageNumber < stopPage) {
      const navigated = await navigateToPage(client, viewState, pageNumber + 1, page);
      viewState = navigated.viewState;
      page = navigated.page;
    }
  }

  if (stopPage >= totalPages) {
    await deleteProgress(paths.progress);
    console.log(`Scrape complete through page ${stopPage}. Progress state deleted; extracted data kept at ${paths.data}.`);
  } else {
    console.log(`Partial scrape complete through page ${stopPage}. Progress state kept for resume; extracted data kept at ${paths.data}.`);
  }
}

function groupFailuresByPage(failures: readonly FailedDownload[]): Map<number, FailedDownload[]> {
  const grouped = new Map<number, FailedDownload[]>();
  for (const failure of failures) {
    const current = grouped.get(failure.pageNumber) ?? [];
    current.push(failure);
    grouped.set(failure.pageNumber, current);
  }
  return new Map([...grouped.entries()].sort(([a], [b]) => a - b));
}

async function runRetry(options: ScraperOptions): Promise<void> {
  const paths = createOutputPaths(options.outputDir);
  await ensureOutput(paths);
  const failures = await readFailedDownloads(paths.failed);
  if (failures.length === 0) {
    console.log('No failed downloads to retry.');
    return;
  }

  const client = new OefaHttpClient(options);
  let { viewState, page } = await bootstrapSearch(client);
  const remaining = new Map<string, FailedDownload>(failures.map((failure: FailedDownload) => [failure.uuid, failure]));

  for (const [pageNumber, pageFailures] of groupFailuresByPage(failures)) {
    if (pageNumber > 1) {
      const navigated = await navigateToPage(client, viewState, pageNumber, page);
      viewState = navigated.viewState;
      page = navigated.page;
    }

    console.log(`Retrying ${pageFailures.length} failed PDF(s) on page ${pageNumber}.`);
    for (const failure of pageFailures) {
      const record = page.records.find((candidate: OefaRecord) => candidate.uuid === failure.uuid);
      const target = record === undefined ? null : toDownloadTarget(record, pageNumber);
      if (target === null) {
        console.warn(`    Could not recover command metadata for ${failure.uuid}.`);
        continue;
      }

      try {
        await downloadTarget(client, viewState, target, paths);
        remaining.delete(failure.uuid);
      } catch (error: unknown) {
        const reason = errorMessage(error);
        remaining.set(failure.uuid, { ...failure, errorReason: reason, timestamp: new Date().toISOString() });
        console.warn(`    Retry failed (${failure.uuid}): ${reason}`);
      }
    }
  }

  await writeFailedDownloads(paths.failed, [...remaining.values()]);
  console.log(`Retry complete. Remaining failures: ${remaining.size}.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'retry') {
    await runRetry(options);
  } else {
    await runScrape(options);
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
