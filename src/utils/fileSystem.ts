import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FailedDownload, ProgressState, ScrapedPage } from '../types';

export interface OutputPaths {
  readonly root: string;
  readonly pdfs: string;
  readonly data: string;
  readonly failed: string;
  readonly progress: string;
}

export function createOutputPaths(outputDir: string): OutputPaths {
  return {
    root: outputDir,
    pdfs: path.join(outputDir, 'pdfs'),
    data: path.join(outputDir, 'data.json'),
    failed: path.join(outputDir, 'failed-downloads.json'),
    progress: path.join(outputDir, 'progress.state'),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureOutput(paths: OutputPaths): Promise<void> {
  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.pdfs, { recursive: true });
}

export async function resetDataFile(dataPath: string): Promise<void> {
  await fs.writeFile(dataPath, '[\n]\n', 'utf8');
}

export async function ensureDataFile(dataPath: string): Promise<void> {
  if (!(await pathExists(dataPath)) || (await fs.stat(dataPath)).size === 0) {
    await resetDataFile(dataPath);
  }
}

export async function appendScrapedPage(dataPath: string, page: ScrapedPage): Promise<void> {
  const serialized = JSON.stringify(page, null, 2).split('\n').map((line: string) => `  ${line}`).join('\n');
  const stat = await fs.stat(dataPath);
  const isEmptyArray = stat.size <= 4;
  const handle = await fs.open(dataPath, 'r+');
  try {
    await handle.truncate(Math.max(0, stat.size - 2));
  } finally {
    await handle.close();
  }
  const prefix = isEmptyArray ? '' : ',\n';
  await fs.appendFile(dataPath, `${prefix}${serialized}\n]\n`, 'utf8');
}

export async function readProgress(progressPath: string): Promise<ProgressState | null> {
  if (!(await pathExists(progressPath))) {
    return null;
  }
  const content = (await fs.readFile(progressPath, 'utf8')).trim();
  if (content.length === 0) {
    return null;
  }

  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const [key, ...rest] = line.split('=');
    if (key !== undefined && key.length > 0) {
      entries.set(key, rest.join('='));
    }
  }

  const nextPage = Number.parseInt(entries.get('nextPage') ?? '1', 10);
  if (!Number.isFinite(nextPage) || nextPage < 1) {
    return null;
  }

  const totalPagesText = entries.get('totalPages');
  const totalRecordsText = entries.get('totalRecords');
  const updatedAt = entries.get('updatedAt');
  return {
    nextPage,
    ...(totalPagesText !== undefined ? { totalPages: Number.parseInt(totalPagesText, 10) } : {}),
    ...(totalRecordsText !== undefined ? { totalRecords: Number.parseInt(totalRecordsText, 10) } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

export async function writeProgress(progressPath: string, state: ProgressState): Promise<void> {
  const lines = [
    `nextPage=${state.nextPage}`,
    ...(state.totalPages !== undefined ? [`totalPages=${state.totalPages}`] : []),
    ...(state.totalRecords !== undefined ? [`totalRecords=${state.totalRecords}`] : []),
    `updatedAt=${state.updatedAt ?? new Date().toISOString()}`,
  ];
  await fs.writeFile(progressPath, `${lines.join('\n')}\n`, 'utf8');
}

export async function deleteProgress(progressPath: string): Promise<void> {
  await fs.rm(progressPath, { force: true });
}

export async function deleteDataFile(dataPath: string): Promise<void> {
  await fs.rm(dataPath, { force: true });
}

export async function readFailedDownloads(failedPath: string): Promise<FailedDownload[]> {
  if (!(await pathExists(failedPath))) {
    return [];
  }
  const content = (await fs.readFile(failedPath, 'utf8')).trim();
  if (content.length === 0) {
    return [];
  }
  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry: unknown): entry is FailedDownload => {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const candidate = entry as Partial<Record<keyof FailedDownload, unknown>>;
    return typeof candidate.uuid === 'string'
      && typeof candidate.identifier === 'string'
      && typeof candidate.pageNumber === 'number'
      && typeof candidate.errorReason === 'string'
      && typeof candidate.timestamp === 'string';
  });
}

export async function writeFailedDownloads(failedPath: string, failures: readonly FailedDownload[]): Promise<void> {
  if (failures.length === 0) {
    await fs.rm(failedPath, { force: true });
    return;
  }
  await fs.writeFile(failedPath, `${JSON.stringify(failures, null, 2)}\n`, 'utf8');
}

export async function recordFailedDownload(failedPath: string, failure: FailedDownload): Promise<void> {
  const failures = await readFailedDownloads(failedPath);
  const withoutDuplicate = failures.filter((item: FailedDownload) => item.uuid !== failure.uuid);
  await writeFailedDownloads(failedPath, [...withoutDuplicate, failure]);
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim() || 'document.pdf';
}

export async function writePdf(pdfsDir: string, filename: string, bytes: Buffer): Promise<string> {
  const safeFilename = sanitizeFilename(filename);
  const outputPath = path.join(pdfsDir, safeFilename.toLowerCase().endsWith('.pdf') ? safeFilename : `${safeFilename}.pdf`);
  await fs.writeFile(outputPath, bytes);
  return outputPath;
}
