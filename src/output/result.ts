import type { CliIo } from '../cli.js';

/**
 * agent 会针对这个结构写解析代码，将来改结构必须能被它发现。只要 JSON 的形状变了
 * （字段改名、语义改变、字段消失），这个数就要涨。
 */
export const SCHEMA_VERSION = 1;

/**
 * 一条命令跑完之后的全部结果：退出码、人读呈现、JSON 呈现，三者都由它承载。
 *
 * 命令自己不做「现在该写人话还是写 JSON」的判断——判断只发生在 writeResult() 里这一处。
 * 分散到每个 io.write 上去判断必然漂移：某天有人在人读分支加了一行提示、JSON 分支里没有，
 * agent 就永远看不见它。构造 CommandResult 的那一个函数里，两种呈现是并排写的，
 * 少给谁一句话当场就看得出来。一份真相，两种呈现。
 */
export interface CommandResult {
  /** JSON 信封里的 command，与用户敲的子命令一致，如 "market convert" */
  command: string;
  exitCode: number;
  /** 人读呈现，已含结尾换行 */
  human: string;
  /** JSON 信封里 schemaVersion / command / exitCode 之外的部分 */
  json: Record<string, unknown>;
}

/** 渲染并写出；返回退出码，好让调用方一行收尾：`return writeResult(...)` */
export function writeResult(io: CliIo, json: boolean, result: CommandResult): number {
  io.write(render(result, json));
  return result.exitCode;
}

export function render(result: CommandResult, json: boolean): string {
  if (!json) return result.human;
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    command: result.command,
    // 退出码本身仍是权威信号，这里带一份只为方便日志与事后归档
    exitCode: result.exitCode,
    ...result.json,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/**
 * 用法错误。--json 下也必须是合法 JSON——agent 拿到的哪怕是「你参数敲错了」，
 * 也得是它 JSON.parse 得动的东西，否则它连自己错在哪都读不到。
 */
export function usageError(command: string, text: string): CommandResult {
  return {
    command,
    exitCode: 1,
    human: text.endsWith('\n') ? text : `${text}\n`,
    json: { error: { code: 'usage', message: text.trim() } },
  };
}

/** 跑到一半抛出来的错。同理：--json 下 stdout 不能是空的，空字符串不是合法 JSON。 */
export function runtimeError(command: string, err: unknown): CommandResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    command,
    exitCode: 1,
    human: `scion: ${message}\n`,
    json: { error: { code: 'error', message } },
  };
}
