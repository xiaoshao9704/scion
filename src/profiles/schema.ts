import { z } from 'zod';
import type { EcosystemProfile } from './types.js';

const FrontmatterRuleSchema = z.object({
  to: z.string().nullable(),
  valueMap: z.record(z.string()).optional(),
  lossy: z.boolean(),
  note: z.string().optional(),
});

export const EcosystemProfileSchema = z.object({
  id: z.enum(['claude', 'kimi', 'codex']),
  manifestPaths: z.array(z.string()).min(1),
  conventions: z.object({
    skills: z.string(),
    commands: z.string(),
    agents: z.string(),
  }),
  fieldDialect: z.object({
    mcpServers: z.enum(['external-file', 'inline', 'path-ref']),
    mcpServersFile: z.string().optional(),
    mcpAuth: z.object({
      expandsInlineVars: z.boolean(),
      headersKey: z.string(),
      bearerTokenEnvField: z.string().nullable(),
      envHeadersField: z.string().nullable(),
    }),
    presentationKey: z.string().nullable(),
    presentationFields: z.array(z.string()),
    runtimeFields: z.array(z.string()),
  }),
  frontmatterMap: z.object({
    agents: z.record(FrontmatterRuleSchema),
    commands: z.record(FrontmatterRuleSchema),
  }),
  pathVar: z.string().nullable(),
  pathVarStrategy: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('keep') }),
    z.object({ kind: z.literal('rename'), to: z.string() }),
    z.object({ kind: z.literal('relativize') }),
  ]),
  unparsedFrontmatter: z.enum(['drops-the-file', 'drops-the-metadata', 'unverified']),
  inlineBash: z.enum(['runs', 'literal', 'unverified']),
  hooksDialect: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('manifest-array'),
      events: z.array(z.string()),
      timeoutMaxSeconds: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal('claude-envelope-file'),
      file: z.string(),
      events: z.array(z.string()),
      note: z.string().optional(),
    }),
    z.object({ kind: z.literal('none') }),
  ]),
  namePattern: z.string().optional(),
  limits: z.object({
    fieldBytes: z.number().optional(),
    totalInstructionBytes: z.number().optional(),
  }),
  install: z.object({
    strategy: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('codex-cli'),
        marketplaceName: z.string(),
        marketplaceRoot: z.string(),
      }),
      z.object({
        kind: z.literal('kimi-managed'),
        rootTemplate: z.string(),
        registryPath: z.string(),
        marketplaceName: z.string(),
        marketplaceRoot: z.string(),
      }),
      z.object({ kind: z.literal('unsupported'), reason: z.string() }),
    ]),
  }).optional(),
  marketplaceDialect: z.object({
    catalogPaths: z.array(z.string()).min(1),
    nameField: z.string().nullable(),
    entryKeyField: z.enum(['name', 'id']),
    entrySourceForm: z.enum(['string', 'object']),
    ownerField: z.enum(['owner', 'interface']).nullable(),
    entryFields: z.array(z.string()),
    catalogFields: z.array(z.string()),
    remoteFetch: z.object({
      hosts: z.array(z.string()).min(1),
      limitation: z.string(),
    }),
  }).optional(),
});

export function assertProfile(value: unknown): EcosystemProfile {
  const parsed = EcosystemProfileSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`invalid profile at ${first.path.join('.')}: ${first.message}`);
  }
  return parsed.data as EcosystemProfile;
}
