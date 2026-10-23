import type { z } from 'zod';
import type { ToolOutput } from './format.js';
import type { HttpClient } from './http.js';
import type { ServerEnv } from './env.js';

/**
 * Tool families, so a deployment on a small free model can expose a subset.
 * Set `MEDICAL_TOOL_GROUPS=literature,drugs` to publish only those.
 */
export const TOOL_GROUPS = [
  'literature',
  'drugs',
  'conditions',
  'trials',
  'epidemiology',
  'devices',
  'clinical',
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** Everything a tool handler is allowed to reach. No globals, no filesystem. */
export interface ToolContext {
  env: ServerEnv;
  http: HttpClient;
}

export interface ToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  group: ToolGroup;
  /** Short human label; LibreChat shows it in the agent's tool picker. */
  title: string;
  /**
   * What the tool answers, when to reach for it, and what it deliberately does
   * not do. This text is the model's only guide to the tool, so it names the
   * upstream and the citation it produces.
   */
  description: string;
  inputSchema: Shape;
  readOnly?: boolean;
  /**
   * Declared as a method so a narrowly typed tool stays assignable to the
   * erased `ToolSpec` the registry holds: parameter bivariance lets the
   * registry call any registered tool without casting at every call site.
   */
  handler(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<ToolOutput>;
}

interface ToolDefinition<Shape extends z.ZodRawShape> extends Omit<ToolSpec<Shape>, 'handler'> {
  handler(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<ToolOutput>;
}

/**
 * Declares a tool with its argument types inferred from the schema, so a handler
 * reads `args.drug` as a string rather than as `any` from the raw shape.
 */
export function defineTool<const Shape extends z.ZodRawShape>(
  definition: ToolDefinition<Shape>,
): ToolSpec<Shape> {
  return definition;
}
