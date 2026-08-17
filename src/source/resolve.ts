import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Finding } from '../ir/types.js';
import { execRunner, runOrThrow, type Runner } from '../install/exec.js';

export interface ResolvedSource {
  dir: string;
  kind: 'path' | 'zip' | 'git';
  original: string;
  ref?: string;
  /** 拉取过程中需要说明的事（目前只有：浅取被拒、回退成完整克隆） */
  notes: string[];
}

/** catalog 写下的 pin。两者都在时以 sha 为准，它更精确 */
export interface GitPin {
  ref?: string;
  sha?: string;
}

/**
 * pin 不可用时抛这个。带着一条 BLOCK finding，让调用方（install）能把它当成一条正常的
 * 检查结果报出去，而不是一个来路不明的运行时异常。
 */
export class PinRejectedError extends Error {
  constructor(readonly finding: Finding) {
    super(finding.message);
    this.name = 'PinRejectedError';
  }
}

const GIT_URL = /^(https?:\/\/|git@|ssh:\/\/)/;
const SHORTHAND = /^[\w.-]+\/[\w.-]+$/;

/** git object id：短 sha 也认，但必须是十六进制且不超过一个完整 object id 的长度 */
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * 一个 ref 敢不敢直接交给 git。只挡三样，每样都有具体理由，不做泛化的"合法 refname"校验
 * （那是 git-check-ref-format 的活，规则多且各版本有出入，自己抄一份只会抄错）：
 *
 * - 空串：`--branch ""` 不是"没有 pin"，是一个 git 认不出的引用
 * - 以 `-` 开头：git 会把它当**选项**读，`--upload-pack=…` 能让 git 去执行本地任意程序
 * - 空白与控制字符：合法的分支名和 tag 里都不会有，出现即说明这个值不是它自称的东西
 */
function usableRef(ref: string): boolean {
  if (ref.length === 0) return false;
  if (ref.startsWith('-')) return false;
  // 连字符只在开头才是问题（会被当选项），中间带 `-` 完全正常（v1.5-beta），不要连坐
  // eslint-disable-next-line no-control-regex
  return !/[\s\u0000-\u001f\u007f]/.test(ref);
}

/**
 * pin 的值是从下载来的 catalog JSON 里读出来的字符串，直接进 git 的 argv。走 argv 数组
 * 不过 shell，所以没有注入风险；真正的问题是 `--upload-pack=…` 这类值会被 git 当**选项**
 * 解析——一个市场条目就能让 scion 去执行本地的任意程序。
 *
 * 不清洗、不截断、不猜测意图：拿不准的 pin 一律拒绝。清洗过的 pin 指向的还是不是 catalog
 * 作者写下的那个 commit，没人说得清，而 pin 的全部意义就在于"就装这个"。
 */
function assertUsablePin(pin: GitPin | undefined, spec: string): void {
  if (!pin) return;

  if (pin.sha !== undefined && !SHA.test(pin.sha)) {
    throw new PinRejectedError({
      level: 'BLOCK',
      code: 'source.pin-unsafe',
      message:
        `the catalog pins this source at sha "${pin.sha}", which is not a git object id ` +
        '(7 to 40 hexadecimal characters). A pin goes straight into git\'s argv, where a value ' +
        'like "--upload-pack=…" is read as an option rather than as a commit; scion refuses the ' +
        'entry instead of sanitising the pin into something the catalog never asked for.',
      where: spec,
    });
  }

  // 空串同样不行：`--branch ""` 不是"没有 pin"，是一个 git 认不出的引用
  if (pin.ref !== undefined && !usableRef(pin.ref)) {
    throw new PinRejectedError({
      level: 'BLOCK',
      code: 'source.pin-unsafe',
      message:
        `the catalog pins this source at ref "${pin.ref}", which scion will not hand to git: ` +
        'a ref must not be empty, must not start with "-" (git would read it as an option), and ' +
        'must not contain whitespace or control characters.',
      where: spec,
    });
  }
}

/**
 * 按 pin 把仓库取到 dir。返回需要转达给用户的说明。
 *
 * 这里唯一不许发生的事：pin 取不到，却拿默认分支的 HEAD 当作成功。那正是"装上了，但装的
 * 不是 catalog 指定的东西"——sha pin 是供应链控制手段，悄悄换成 HEAD 等于把它作废。
 */
async function fetchGit(
  run: Runner,
  url: string,
  dir: string,
  pin: GitPin | undefined,
): Promise<string[]> {
  if (pin?.sha) return fetchSha(run, url, dir, pin.sha);

  if (pin?.ref) {
    // --branch 同时接受分支名与 tag，正是 catalog 里 ref 的两种写法
    try {
      await runOrThrow(run, 'git', ['clone', '--depth', '1', '--branch', pin.ref, url, dir]);
    } catch (err) {
      throw new Error(
        `cannot clone ${url} at the ref this source is pinned to (${pin.ref}):\n` +
          `${indent((err as Error).message)}\n` +
          'Refusing to clone the default branch instead: that would install a different commit than the catalog asked for.',
      );
    }
    return [];
  }

  await runOrThrow(run, 'git', ['clone', '--depth', '1', url, dir]);
  return [];
}

async function fetchSha(run: Runner, url: string, dir: string, sha: string): Promise<string[]> {
  // 浅取优先：只下这一个 commit。但很多服务端默认不开
  // uploadpack.allowReachableSHA1InWant，按任意 sha 浅取被拒是常态、不是异常。
  try {
    await runOrThrow(run, 'git', ['init', dir]);
    await runOrThrow(run, 'git', ['-C', dir, 'remote', 'add', 'origin', url]);
    await runOrThrow(run, 'git', ['-C', dir, 'fetch', '--depth', '1', 'origin', sha]);
    await runOrThrow(run, 'git', ['-C', dir, 'checkout', 'FETCH_HEAD']);
    return [];
  } catch (shallowErr) {
    const shallow = (shallowErr as Error).message;
    // 半个仓库留在原地会让 clone 拒绝写入；这个目录已经过 assertInsideSrcCache
    await rm(dir, { recursive: true, force: true });
    try {
      await runOrThrow(run, 'git', ['clone', url, dir]);
      await runOrThrow(run, 'git', ['-C', dir, 'checkout', sha]);
    } catch (fullErr) {
      throw new Error(
        `cannot fetch the commit this source is pinned to (sha ${sha}) from ${url}; both ways of getting it failed:\n` +
          `  shallow fetch of the sha:\n${indent((shallowErr as Error).message, 4)}\n` +
          `  full clone, then checkout:\n${indent((fullErr as Error).message, 4)}\n` +
          'Refusing to fall back to the default branch: its HEAD is not the commit the catalog pinned, ' +
          'and installing it would silently defeat the pin.',
      );
    }
    return [
      `the pinned sha ${sha} could not be fetched shallowly (most git servers refuse to serve an ` +
        `arbitrary sha), so scion fell back to a full clone of ${url} and checked the sha out — ` +
        `slower, and it downloads the whole history. The shallow attempt failed with: ${firstLine(shallow)}`,
    ];
  }
}

function indent(text: string, width = 2): string {
  const pad = ' '.repeat(width);
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

function firstLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? text;
}

/** 把 URL 压成一个可用作目录名的 slug */
export function sourceSlug(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/[^\w.-]+/g, '_');
}

/**
 * 确认 dir 真的落在 <home>/.scion/src/ 内部，再允许对它做任何破坏性操作。
 * 不枚举"坏 slug"（如 "."、".."）——那治标不治本，下一个奇怪输入还会找到别的路子；
 * 直接校验最终落点，任何绕过 slug 净化的方式都会在这里被挡住。
 * 用 startsWith(srcRoot + sep) 而不是裸 startsWith(srcRoot)：避免把
 * "<home>/.scion/src-evil" 这类前缀相似但并不在目录内部的路径误判为安全
 * （同 Task 16 assertSafeOutDir 修的那个边界 bug）。
 */
function assertInsideSrcCache(home: string, dir: string, spec: string): void {
  const srcRoot = join(home, '.scion', 'src');
  const resolved = resolve(dir);
  if (resolved === srcRoot || !resolved.startsWith(srcRoot + sep)) {
    throw new Error(
      `refusing to touch '${resolved}' while resolving source '${spec}': it is not inside the scion source cache (${srcRoot})`,
    );
  }
}

export async function resolveSource(
  spec: string,
  opts: { home: string; run?: Runner; pin?: GitPin },
): Promise<ResolvedSource> {
  const run = opts.run ?? execRunner;

  // 校验放在最前面，早于任何 stat / mkdir / rm：一个不可用的 pin 意味着这个条目整个
  // 不该被碰，让它先在文件系统上留下痕迹再拒绝，只是把清理工作留给别人。
  assertUsablePin(opts.pin, spec);

  // git URL 先于本地路径判定：形如 "https://.." 的输入经 path.resolve 会塌回
  // cwd（"https:" 段与末尾的 ".." 相消），而 cwd 必然存在，会被下面的目录检查
  // 抢先当成 kind:'path' 吞掉，把一个明显写错的 URL 静默变成"当前目录"。
  // 带 scheme 的 spec 不可能是本地目录，先分流掉即可。
  // 注意 SHORTHAND（owner/repo）不能一起前移：它同样匹配 "some/dir" 这类相对
  // 目录路径，前移会把真实的本地目录误判成 github 仓库。
  const gitUrl = GIT_URL.test(spec) ? spec : null;

  const asPath = resolve(spec);
  let info: Awaited<ReturnType<typeof stat>> | null = null;
  if (!gitUrl) {
    try {
      info = await stat(asPath);
    } catch {
      info = null;
    }
  }

  if (info?.isDirectory()) return { dir: spec, kind: 'path', original: spec, notes: [] };

  if (info?.isFile() && spec.endsWith('.zip')) {
    const dir = join(opts.home, '.scion', 'src', sourceSlug(spec));
    assertInsideSrcCache(opts.home, dir, spec);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    // macOS / Linux 均自带 unzip；避免为此引入依赖
    await runOrThrow(run, 'unzip', ['-q', asPath, '-d', dir]);
    return { dir, kind: 'zip', original: spec, notes: [] };
  }

  const url = gitUrl ?? (SHORTHAND.test(spec) ? `https://github.com/${spec}.git` : null);

  if (url) {
    const dir = join(opts.home, '.scion', 'src', sourceSlug(url));
    assertInsideSrcCache(opts.home, dir, spec);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(opts.home, '.scion', 'src'), { recursive: true });
    const notes = await fetchGit(run, url, dir, opts.pin);
    return { dir, kind: 'git', original: spec, notes };
  }

  throw new Error(`cannot resolve source '${spec}' (expected a directory, a .zip, owner/repo, or a git URL)`);
}
