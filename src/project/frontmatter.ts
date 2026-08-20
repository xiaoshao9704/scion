import matter from 'gray-matter';
import type { Finding } from '../ir/types.js';
import type { EcosystemProfile } from '../profiles/types.js';

export interface RemapResult {
  content: string;
  findings: Finding[];
}

export type FrontmatterKind = 'agents' | 'commands';

export function remapFrontmatter(
  source: string,
  kind: FrontmatterKind,
  from: EcosystemProfile,
  to: EcosystemProfile,
  where: string,
): RemapResult {
  const findings: Finding[] = [];

  // frontmatter 不是合法 YAML 时不许把整次转换掀掉。真实插件里这种文件是存在的
  // （典型是 argument-hint 的值以 "[" 开头被 YAML 当成流式序列，而后面还跟着别的
  // 字符），宿主自己未必较真，但 gray-matter 会抛，异常一路冒到顶层就成了一条没有
  // 插件名、没有文件名的报错——用户拿着它无从下手。
  //
  // 处理方式是原样复制 + 报 LOSS，而不是跳过这个文件：跳过等于静默丢一条命令。
  // 原样复制意味着字段没有被重映射——源生态独有的字段（allowed-tools 之类）会原封
  // 不动留在产物里，model 之类的取值也不会被降档，这些都是真损耗，必须说出来。
  //
  // 第二个参数不能省。gray-matter 带一个按内容字符串索引的**全局缓存**，而且解析抛错
  // 之后仍会留下缓存条目：同一份坏内容第二次解析不再抛，直接返回空 frontmatter。一次
  // install 里同一个文件本来就要过好几遍（doctor 一遍、preview 再一遍，多目标再乘一遍），
  // 于是第二遍开始这个文件就被静默放行、一条 finding 都不报——正是本工具要消灭的那种坏。
  // 传任意 options 对象即可完全绕开该缓存（gray-matter 只在无 options 时读写它）。
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(source, {});
  } catch (err) {
    const reason = (err as Error).message.split('\n')[0];
    const singular = kind === 'commands' ? 'command' : 'agent';
    // 「原样复制」的后果由目标端决定，所以这句话必须从 profile 声明的实测事实里来，
    // 不能写死。在 Kimi 上量到的是最坏的那种：宿主自己也解析不动，然后静默丢弃整个文件。
    const consequence = {
      'drops-the-file':
        `${to.id} parses this frontmatter too, and drops the whole file when it cannot: this ` +
        `${singular} will not exist there at all — no error, no degraded version`,
      'drops-the-metadata':
        `${to.id} cannot parse it either: it loads the file and runs the body, but treats the ` +
        `frontmatter as empty, so everything declared there is silently not applied — including any ` +
        `tool allowlist, which means this ${singular} runs unrestricted`,
      unverified:
        `whether ${to.id} still loads a file it cannot parse is untested — it may work with no field ` +
        `remapped, or be dropped entirely`,
    }[to.unparsedFrontmatter];
    findings.push({
      level: 'LOSS',
      code: 'frontmatter.unparsed',
      message:
        `the frontmatter is not valid YAML (${reason}), so scion copied the file verbatim instead of ` +
        `converting it. ${consequence}. Quote the offending value upstream to fix it`,
      where,
    });
    return { content: source, findings };
  }

  // gray-matter 对无 frontmatter 的文件返回空 data，此时原样返回，避免平白加上 "---"
  if (Object.keys(parsed.data).length === 0) {
    return { content: source, findings };
  }

  const sourceRules = from.frontmatterMap[kind];
  const targetRules = to.frontmatterMap[kind];
  const out: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(parsed.data)) {
    if (!(field in sourceRules)) {
      findings.push({
        level: 'INFO',
        code: 'frontmatter.field-unknown',
        message: `the ${from.id} profile does not declare the ${kind} field "${field}"; kept as-is`,
        where: `${where}#${field}`,
      });
      out[field] = value;
      continue;
    }

    const rule = targetRules[field];

    if (!rule || rule.to === null) {
      findings.push({
        level: 'LOSS',
        code: 'frontmatter.field-dropped',
        message: rule?.note ?? `${to.id} has no matching field; "${field}" dropped`,
        where: `${where}#${field}`,
      });
      continue;
    }

    if (rule.valueMap && typeof value === 'string') {
      const mapped = rule.valueMap[value];
      if (mapped === undefined) {
        findings.push({
          level: 'LOSS',
          code: 'frontmatter.value-unmapped',
          message: `"${field}: ${value}" has no matching value on ${to.id}; the field is dropped`,
          where: `${where}#${field}`,
        });
        continue;
      }
      out[rule.to] = mapped;
      findings.push({
        level: rule.lossy ? 'LOSS' : 'INFO',
        code: 'frontmatter.value-mapped',
        message: rule.note
          ? `${rule.note} (${field}: ${value} → ${rule.to}: ${mapped})`
          : `${field}: ${value} → ${rule.to}: ${mapped}`,
        where: `${where}#${field}`,
      });
      continue;
    }

    out[rule.to] = value;
    if (rule.lossy) {
      findings.push({
        level: 'LOSS',
        code: 'frontmatter.field-lossy',
        message: rule.note ?? `${field} → ${rule.to} is a lossy mapping`,
        where: `${where}#${field}`,
      });
    }
  }

  return { content: matter.stringify(parsed.content, out), findings };
}
