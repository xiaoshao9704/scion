import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 备份既有文件；文件不存在时返回 null */
export async function backupFile(path: string, stamp: string): Promise<string | null> {
  const backup = `${path}.scion-bak.${stamp}`;
  try {
    await copyFile(path, backup);
    return backup;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.scion-tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}
