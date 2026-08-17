import { z } from 'zod';
import type { EcosystemId, PluginIR } from './types.js';

const EcosystemIdSchema = z.enum(['claude', 'kimi', 'codex']);

const ProvenanceSchema = z.object({
  field: z.string(),
  source: z.enum(['manifest', 'convention', 'profile-default']),
  detail: z.string().optional(),
});

export const FindingSchema = z.object({
  level: z.enum(['BLOCK', 'LOSS', 'INFO']),
  code: z.string(),
  message: z.string(),
  where: z.string().optional(),
});

const CapabilityDirSchema = z.object({
  path: z.string(),
  entries: z.array(z.string()),
});

const IdentitySchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

const McpEnvRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bearer'), envVar: z.string() }),
  z.object({ kind: z.literal('header-value'), header: z.string(), envVar: z.string() }),
  z.object({ kind: z.literal('inline'), at: z.array(z.string()), envVar: z.string() }),
]);

const McpServerAuthSchema = z.object({
  headers: z.record(z.string()),
  refs: z.array(McpEnvRefSchema),
});

const CapabilitiesSchema = z.object({
  skills: CapabilityDirSchema.nullable(),
  commands: CapabilityDirSchema.nullable(),
  agents: CapabilityDirSchema.nullable(),
  hooks: z.array(z.string()),
  mcpServers: z.record(z.record(z.unknown())),
  mcpAuth: z.record(McpServerAuthSchema),
});

const PresentationSchema = z.object({
  displayName: z.string().optional(),
  shortDescription: z.string().optional(),
  longDescription: z.string().optional(),
  developerName: z.string().optional(),
  category: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  defaultPrompt: z.array(z.string()).optional(),
  brandColor: z.string().optional(),
  icon: z.string().optional(),
  logo: z.string().optional(),
  screenshots: z.array(z.string()).optional(),
  websiteURL: z.string().optional(),
  privacyPolicyURL: z.string().optional(),
  termsOfServiceURL: z.string().optional(),
});

const RuntimeSchema = z.object({
  sessionStart: z.object({ skill: z.string() }).optional(),
  skillInstructions: z.string().optional(),
  systemPrompt: z.string().optional(),
  systemPromptPath: z.string().optional(),
});

export const PluginIRSchema: z.ZodType<PluginIR> = z.object({
  root: z.string(),
  sourceEcosystem: EcosystemIdSchema,
  identity: IdentitySchema,
  capabilities: CapabilitiesSchema,
  presentation: PresentationSchema,
  runtime: RuntimeSchema,
  provenance: z.array(ProvenanceSchema),
  issues: z.array(FindingSchema),
});

export function assertIR(value: unknown): PluginIR {
  const parsed = PluginIRSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`invalid PluginIR at ${first.path.join('.')}: ${first.message}`);
  }
  return parsed.data;
}

export function emptyIR(root: string, sourceEcosystem: EcosystemId): PluginIR {
  return {
    root,
    sourceEcosystem,
    identity: { name: '' },
    capabilities: {
      skills: null,
      commands: null,
      agents: null,
      hooks: [],
      mcpServers: {},
      mcpAuth: {},
    },
    presentation: {},
    runtime: {},
    provenance: [],
    issues: [],
  };
}
