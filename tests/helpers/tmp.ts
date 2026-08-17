import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** 按 { 相对路径: 内容 } 建一个临时插件目录，返回绝对路径 */
export async function makePluginDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scion-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return root;
}
