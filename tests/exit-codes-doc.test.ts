import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { usageError } from '../src/output/result.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * docs/exit-codes.md 与代码之间本来没有任何绑定：改一个返回码，文档会静默过期。
 * 而 `--json` 的整个前提是「agent 先按退出码粗分支，再看 JSON 细分支」，一份会过期的
 * 退出码文档比没有更糟。这里用正则从源码里把码抽出来跟文档对账。
 *
 * 抽取宁宽勿窄——漏抽（文档写了、代码其实没有，或反过来）才是危险的，多抽出来的假阳性
 * 会当场炸在这个测试里，一眼能看见。已知的合理差异写进 documentedOnly，必须逐条给理由。
 */
interface CommandSource {
  file: string;
  /** docs/exit-codes.md 里 "## Per command" 下的小节标题（去掉 "### "） */
  sections: string[];
  /** 文档里有、源码里抽不到的码，以及为什么 */
  documentedOnly?: Record<number, string>;
}

const SOURCES: CommandSource[] = [
  { file: 'src/cli.ts', sections: ['`scion` itself'] },
  { file: 'src/commands/doctor.ts', sections: ['`scion doctor`'] },
  { file: 'src/commands/convert.ts', sections: ['`scion convert`'] },
  { file: 'src/commands/install.ts', sections: ['`scion install`'] },
  { file: 'src/commands/uninstall.ts', sections: ['`scion uninstall`'] },
  { file: 'src/commands/repo.ts', sections: ['`scion repo`'] },
  { file: 'src/commands/list.ts', sections: ['`scion list`'] },
  {
    file: 'src/commands/market.ts',
    sections: ['`scion market convert`', '`scion market show`'],
  },
  {
    file: 'src/commands/sync.ts',
    sections: ['`scion sync`'],
    documentedOnly: {
      2: 'sync 原样透传 install 的退出码，自己不产生',
      3: 'sync 原样透传 install 的退出码，自己不产生',
      5: 'sync 原样透传 install 的退出码，自己不产生',
    },
  },
];

/** 词法扫描时的嵌套层：普通代码 / 模板串 / 模板串里的 ${} 插值 */
interface Frame {
  kind: 'code' | 'template' | 'interp';
  /** 只对 interp 有意义：数花括号，找到与 ${ 配对的那个 } */
  braces: number;
}

/**
 * 把注释和字符串字面量剥成空壳，只留下真正的代码结构，免得中文注释或用户文案里的
 * 数字被当成退出码。
 *
 * 必须按词法状态一遍扫过去，不能像从前那样用几条全局正则轮流剥离。轮流剥离的版本里，
 * 模板串里的一个撇号（`scion's`）会被"单引号字面量"那条规则当成开头，一路吞到文件里
 * 下一个撇号为止——中间的真实代码连同 return 语句一起消失，抽取结果直接变成空集。
 * 这个测试的全部价值就在于"抽出来的码要和文档对得上"，一个撇号就能让它整个失效、
 * 逼下一个人绕着措辞写代码，那它就从守门人变成了噪音。实测踩过一次，所以改成词法扫描。
 *
 * 唯一还骗得过它的是含引号的正则字面量（`/['"]/`）——目前源码里没有，真出现了抽取
 * 结果会当场对不上、测试报错，不会静默错过。
 */
function stripNoise(src: string): string {
  const out: string[] = [];
  const stack: Frame[] = [{ kind: 'code', braces: 0 }];
  let i = 0;

  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const next = src[i + 1];

    if (top.kind === 'template') {
      if (c === '\\') {
        i += 2;
      } else if (c === '`') {
        stack.pop();
        // 插值里的模板串整段都是要丢掉的内容，别让占位符漏进输出
        if (stack[stack.length - 1].kind === 'code') out.push('``');
        i += 1;
      } else if (c === '$' && next === '{') {
        stack.push({ kind: 'interp', braces: 0 });
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    // code 与 interp 的词法规则相同，区别只在于 interp 的内容不输出，且要数到配对的 }
    const keep = top.kind === 'code';

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      if (keep) out.push(' ');
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      if (keep) out.push(' ');
    } else if (c === "'" || c === '"') {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      if (keep) out.push(c + c);
    } else if (c === '`') {
      stack.push({ kind: 'template', braces: 0 });
      i += 1;
    } else if (top.kind === 'interp' && c === '{') {
      top.braces += 1;
      i += 1;
    } else if (top.kind === 'interp' && c === '}') {
      if (top.braces === 0) stack.pop();
      else top.braces -= 1;
      i += 1;
    } else {
      if (keep) out.push(c);
      i += 1;
    }
  }

  return out.join('');
}

function collectInts(expr: string, into: Set<number>): void {
  // 排除 foo[0]、a.0 这类下标/属性位置上的数字
  for (const m of expr.matchAll(/(?<![\w.$[])\d+/g)) into.add(Number(m[0]));
}

function extractCodes(src: string): Set<number> {
  const clean = stripNoise(src);
  const codes = new Set<number>();
  for (const m of clean.matchAll(/\breturn\s+([^;]+);/g)) collectInts(m[1], codes);
  for (const m of clean.matchAll(/\bexitCode\s*[:=]\s*([^,;\n}]+)/g)) collectInts(m[1], codes);
  // usageError() 是唯一把码藏在辅助函数里的地方，它永远是 1（下面有断言钉住）
  if (/\busageError\(/.test(clean)) codes.add(usageError('x', 'y').exitCode);
  return codes;
}

/** 取一个 markdown 表格首列里的所有整数；跳过表头与分隔行 */
function codesInTable(block: string): Set<number> {
  const codes = new Set<number>();
  for (const m of block.matchAll(/^\|([^|]*)\|/gm)) {
    const cell = m[1].trim();
    if (!cell || /^-+$/.test(cell.replace(/[\s:]/g, '')) || /code/i.test(cell)) continue;
    for (const n of cell.matchAll(/\d+/g)) codes.add(Number(n[0]));
  }
  return codes;
}

function sectionBlocks(doc: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const parts = doc.split(/^### /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    blocks.set(part.slice(0, nl).trim(), part.slice(nl));
  }
  return blocks;
}

/**
 * 抽取器自己的守卫。这段假源码是照着真实翻车现场剪的：模板串里一个 `scion's`，
 * 撇号之后隔着两条 return 才出现下一个单引号。老的"轮流剥离"版本会把这中间的一切
 * 当成一个字符串字面量吃掉，两条 return 一起消失，抽出的码只剩 exitCode 那个 2。
 */
const SOURCE_WITH_APOSTROPHES = [
  '// 注释里也可以有撇号：don’t 与 don\'t 都不该影响下面',
  'function run(): number {',
  '  io.write(`fetch them one at a time into scion\'s own marketplace`);',
  '  io.write(`${label} — ${n === 1 ? `one` : `many`}`);',
  '  if (bad) return 4;',
  '  return 0;',
  '}',
  "const label = 'market convert';",
  'const result = { exitCode: 2 };',
].join('\n');

describe('the exit-code extractor itself', () => {
  it('is not derailed by an apostrophe inside a template literal', () => {
    expect([...extractCodes(SOURCE_WITH_APOSTROPHES)].sort((a, b) => a - b)).toEqual([0, 2, 4]);
  });

  it('still ignores numbers that live in comments and strings', () => {
    const src = [
      '// 退出码 7 只是注释里的一个数字',
      '/* 块注释里的 8 也一样 */',
      "const usage = 'pass --to kimi 9 times';",
      'function run(): number { return 3; }',
    ].join('\n');
    expect([...extractCodes(src)]).toEqual([3]);
  });
});

describe('docs/exit-codes.md matches the code', () => {
  it('usageError is the documented usage-error code', () => {
    expect(usageError('x', 'y').exitCode).toBe(1);
  });

  it('covers every command source file', async () => {
    const listed = new Set(SOURCES.map((s) => s.file));
    for (const f of await readdir(join(repoRoot, 'src/commands'))) {
      expect(listed.has(`src/commands/${f}`)).toBe(true);
    }
  });

  it('documents exactly the codes each command returns', async () => {
    const doc = await readFile(join(repoRoot, 'docs/exit-codes.md'), 'utf8');
    const blocks = sectionBlocks(doc);

    for (const source of SOURCES) {
      const documented = new Set<number>();
      for (const section of source.sections) {
        const block = blocks.get(section);
        expect(block, `docs/exit-codes.md has no "### ${section}" section`).toBeDefined();
        for (const c of codesInTable(block!)) documented.add(c);
      }

      const actual = extractCodes(await readFile(join(repoRoot, source.file), 'utf8'));
      for (const [code, why] of Object.entries(source.documentedOnly ?? {})) {
        expect(why.length).toBeGreaterThan(0);
        actual.add(Number(code));
      }

      expect(
        [...actual].sort((a, b) => a - b),
        `${source.file} vs ${source.sections.join(' + ')}`,
      ).toEqual([...documented].sort((a, b) => a - b));
    }
  });

  it('lists every per-command code in the at-a-glance table', async () => {
    const doc = await readFile(join(repoRoot, 'docs/exit-codes.md'), 'utf8');
    const blocks = sectionBlocks(doc);
    const perCommand = new Set<number>();
    for (const source of SOURCES) {
      for (const section of source.sections) {
        for (const c of codesInTable(blocks.get(section) ?? '')) perCommand.add(c);
      }
    }

    const glance = doc.split(/^## /m).find((b) => b.startsWith('All codes at a glance')) ?? '';
    expect([...codesInTable(glance)].sort()).toEqual([...perCommand].sort());
  });
});
