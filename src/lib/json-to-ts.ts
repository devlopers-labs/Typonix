export type NamingStyle = "pascal" | "camel";
export type OutputFormat = "typescript" | "zod" | "typeGuards" | "jsonSchema";
export type SpecialType = "none" | "date" | "uuid" | "email" | "url" | "phone";

export interface GeneratorOptions {
  rootName: string;
  namingStyle: NamingStyle;
  prefix: string;
  suffix: string;
  readonly: boolean;
  exportInterfaces: boolean;
  useEnums: boolean;
  splitNestedInterfaces: boolean;
}

export interface GeneratorResult {
  code: string;
  interfaceCount: number;
  enumCount: number;
  rootTypeName: string;
  format: OutputFormat;
}

export interface FieldStatistics {
  totalFields: number;
  sampleCount: number;
  maxDepth: number;
  topLevelKeys: string[];
  typeBreakdown: {
    strings: number;
    numbers: number;
    booleans: number;
    nulls: number;
    objects: number;
    arrays: number;
  };
  specialTypes: Record<Exclude<SpecialType, "none">, number>;
}

export interface AutoFixResult {
  ok: boolean;
  fixed: string;
  changes: string[];
  error?: string;
}

export interface TreeNode {
  id: string;
  label: string;
  type: string;
  children?: TreeNode[];
}

export type ParseResult =
  | {
      ok: true;
      mode: "single" | "multiple";
      value: unknown;
      samples: unknown[];
      formatted: string;
    }
  | {
      ok: false;
      error: string;
    };

interface NodeStats {
  samples: number;
  stringSamples: number;
  numberSamples: number;
  booleanSamples: number;
  nullSamples: number;
  objectSamples: number;
  arraySamples: number;
  stringValues: Map<string, number>;
  objectProps: Map<string, { count: number; node: NodeStats }>;
  arrayElement: NodeStats | null;
}

type SchemaNode =
  | {
      kind: "string";
      values: string[];
      specialType: SpecialType;
    }
  | {
      kind: "number";
    }
  | {
      kind: "boolean";
    }
  | {
      kind: "null";
    }
  | {
      kind: "unknown";
    }
  | {
      kind: "array";
      element: SchemaNode;
    }
  | {
      kind: "object";
      properties: Array<{
        key: string;
        optional: boolean;
        node: SchemaNode;
      }>;
    }
  | {
      kind: "union";
      members: SchemaNode[];
    };

interface TsEmitContext {
  options: GeneratorOptions;
  forceNamedObjects: boolean;
  usedNames: Set<string>;
  objectNames: WeakMap<object, string>;
  enumNames: WeakMap<object, string>;
  objectBlocks: Map<string, string>;
  enumBlocks: Map<string, string>;
  objectOrder: string[];
  enumOrder: string[];
}

interface ZodEmitContext {
  options: GeneratorOptions;
  forceNamedObjects: boolean;
  usedNames: Set<string>;
  schemaNames: WeakMap<object, string>;
  schemaBlocks: Map<string, string>;
  schemaOrder: string[];
}

interface JsonSchemaContext {
  options: GeneratorOptions;
  usedNames: Set<string>;
  objectNames: WeakMap<object, string>;
  definitions: Record<string, unknown>;
}

function createNode(): NodeStats {
  return {
    samples: 0,
    stringSamples: 0,
    numberSamples: 0,
    booleanSamples: 0,
    nullSamples: 0,
    objectSamples: 0,
    arraySamples: 0,
    stringValues: new Map(),
    objectProps: new Map(),
    arrayElement: null,
  };
}

function observe(node: NodeStats, value: unknown) {
  node.samples += 1;

  if (value === null) {
    node.nullSamples += 1;
    return;
  }

  if (Array.isArray(value)) {
    node.arraySamples += 1;
    if (!node.arrayElement) {
      node.arrayElement = createNode();
    }

    for (const item of value) {
      observe(node.arrayElement, item);
    }
    return;
  }

  switch (typeof value) {
    case "string":
      node.stringSamples += 1;
      node.stringValues.set(value, (node.stringValues.get(value) ?? 0) + 1);
      return;
    case "number":
      node.numberSamples += 1;
      return;
    case "boolean":
      node.booleanSamples += 1;
      return;
    case "object":
      node.objectSamples += 1;
      for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
        const existing = node.objectProps.get(key);
        if (existing) {
          existing.count += 1;
          observe(existing.node, childValue);
        } else {
          const childNode = createNode();
          observe(childNode, childValue);
          node.objectProps.set(key, { count: 1, node: childNode });
        }
      }
      return;
    default:
      return;
  }
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function singularize(value: string) {
  if (!value) {
    return "Item";
  }

  if (/ies$/i.test(value)) {
    return value.replace(/ies$/i, "y");
  }

  if (/ses$/i.test(value)) {
    return value.replace(/es$/i, "");
  }

  if (/s$/i.test(value) && !/ss$/i.test(value)) {
    return value.replace(/s$/i, "");
  }

  return value;
}

function splitWords(input: string) {
  const normalized = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim();

  if (!normalized) {
    return ["root", "data"];
  }

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function applyStyle(input: string, style: NamingStyle) {
  const words = splitWords(input);
  if (style === "camel") {
    const [first = "root", ...rest] = words;
    return [first, ...rest.map(capitalize)].join("");
  }
  return words.map(capitalize).join("");
}

function sanitizeTypeName(input: string) {
  const fallback = input || "RootData";
  const cleaned = fallback.replace(/[^a-zA-Z0-9_$]/g, "");
  if (!cleaned) {
    return "RootData";
  }
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `T${cleaned}`;
}

function sanitizeEnumMember(input: string, index: number, used: Set<string>) {
  const base = sanitizeTypeName(applyStyle(input || `Value${index + 1}`, "pascal"));
  let candidate = base || `Value${index + 1}`;
  let suffix = 2;

  while (used.has(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }

  used.add(candidate);
  return candidate;
}

function reserveName(usedNames: Set<string>, preferred: string) {
  const base = sanitizeTypeName(preferred);
  let candidate = base;
  let suffix = 2;

  while (usedNames.has(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function compactUnion(members: SchemaNode[]): SchemaNode[] {
  const flattened = members.flatMap((member) => (member.kind === "union" ? member.members : [member]));
  const deduped: SchemaNode[] = [];
  const seen = new Set<string>();

  for (const member of flattened) {
    const key = getSchemaSignature(member);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(member);
    }
  }

  return deduped;
}

function getSchemaSignature(node: SchemaNode): string {
  switch (node.kind) {
    case "string":
      return `string:${node.specialType}:${node.values.join("|")}`;
    case "number":
    case "boolean":
    case "null":
    case "unknown":
      return node.kind;
    case "array":
      return `array:${getSchemaSignature(node.element)}`;
    case "object":
      return `object:${node.properties
        .map((property) => `${property.key}:${property.optional ? "optional" : "required"}:${getSchemaSignature(property.node)}`)
        .join(";")}`;
    case "union":
      return `union:${node.members.map(getSchemaSignature).sort().join("|")}`;
  }
}

function detectSpecialType(values: string[]): SpecialType {
  const filtered = values.filter(Boolean);
  if (!filtered.length) {
    return "none";
  }

  const isEmail = filtered.every((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  if (isEmail) return "email";

  const isUuid = filtered.every((value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
  if (isUuid) return "uuid";

  const isIsoDate = filtered.every((value) =>
    /^\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)
  );
  if (isIsoDate) return "date";

  const isUrl = filtered.every((value) => {
    try {
      const url = new URL(value);
      return Boolean(url.protocol && url.host);
    } catch {
      return false;
    }
  });
  if (isUrl) return "url";

  const isPhone = filtered.every((value) => /^\+?[\d\s().-]{7,}$/.test(value));
  if (isPhone) return "phone";

  return "none";
}

function shouldUseEnum(node: Extract<SchemaNode, { kind: "string" }>, options: GeneratorOptions) {
  return options.useEnums && node.values.length >= 2 && node.values.length <= 8;
}

function shouldUseLiteralUnion(node: Extract<SchemaNode, { kind: "string" }>) {
  return node.values.length >= 2 && node.values.length <= 6;
}

function nodeStatsToSchema(node: NodeStats): SchemaNode {
  const members: SchemaNode[] = [];

  if (node.objectSamples > 0) {
    const properties = [...node.objectProps.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, meta]) => ({
        key,
        optional: meta.count < node.objectSamples,
        node: nodeStatsToSchema(meta.node),
      }));

    members.push({
      kind: "object",
      properties,
    });
  }

  if (node.arraySamples > 0) {
    members.push({
      kind: "array",
      element: node.arrayElement ? nodeStatsToSchema(node.arrayElement) : { kind: "unknown" },
    });
  }

  if (node.stringSamples > 0) {
    const values = [...node.stringValues.keys()].sort();
    members.push({
      kind: "string",
      values,
      specialType: detectSpecialType(values),
    });
  }

  if (node.numberSamples > 0) members.push({ kind: "number" });
  if (node.booleanSamples > 0) members.push({ kind: "boolean" });
  if (node.nullSamples > 0) members.push({ kind: "null" });

  const compacted = compactUnion(members);
  if (!compacted.length) {
    return { kind: "unknown" };
  }

  return compacted.length === 1 ? compacted[0] : { kind: "union", members: compacted };
}

function createRootSchema(samples: unknown[]) {
  const rootNode = createNode();
  for (const sample of samples) {
    observe(rootNode, sample);
  }
  return nodeStatsToSchema(rootNode);
}

function formatSpecialTypeTs(node: Extract<SchemaNode, { kind: "string" }>) {
  return shouldUseLiteralUnion(node) ? node.values.map((value) => JSON.stringify(value)).join(" | ") : "string";
}

export function formatTypeName(input: string, style: NamingStyle, prefix = "", suffix = "") {
  const styled = applyStyle(input, style);
  return sanitizeTypeName(`${prefix}${styled}${suffix}`);
}

export function formatPropertyName(input: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input) ? input : JSON.stringify(input);
}

function tsNeedsParens(typeName: string) {
  return typeName.includes(" | ");
}

function createTsContext(options: GeneratorOptions, forceNamedObjects: boolean): TsEmitContext {
  return {
    options,
    forceNamedObjects,
    usedNames: new Set<string>(),
    objectNames: new WeakMap<object, string>(),
    enumNames: new WeakMap<object, string>(),
    objectBlocks: new Map<string, string>(),
    enumBlocks: new Map<string, string>(),
    objectOrder: [],
    enumOrder: [],
  };
}

function createChildHint(parentHint: string, propertyKey: string) {
  return `${parentHint}${applyStyle(singularize(propertyKey), "pascal")}`;
}

function ensureTsEnum(node: Extract<SchemaNode, { kind: "string" }>, hint: string, ctx: TsEmitContext) {
  const existing = ctx.enumNames.get(node as object);
  if (existing) {
    return existing;
  }

  const enumName = reserveName(
    ctx.usedNames,
    formatTypeName(hint || "Status", ctx.options.namingStyle, ctx.options.prefix, ctx.options.suffix)
  );
  const usedMembers = new Set<string>();
  const keyword = ctx.options.exportInterfaces ? "export enum" : "enum";
  const members = node.values.map((value, index) => {
    const memberName = sanitizeEnumMember(value, index, usedMembers);
    return `  ${memberName} = ${JSON.stringify(value)},`;
  });

  ctx.enumNames.set(node as object, enumName);
  ctx.enumBlocks.set(enumName, `${keyword} ${enumName} {\n${members.join("\n")}\n}`);
  ctx.enumOrder.push(enumName);
  return enumName;
}

function emitTsObjectBody(node: Extract<SchemaNode, { kind: "object" }>, hint: string, ctx: TsEmitContext): string {
  if (!node.properties.length) {
    return "{}";
  }

  const lines = node.properties.map((property) => {
    const childType = emitTsType(property.node, createChildHint(hint, property.key), ctx);
    const readonlyToken = ctx.options.readonly ? "readonly " : "";
    const optionalToken = property.optional ? "?" : "";
    return `  ${readonlyToken}${formatPropertyName(property.key)}${optionalToken}: ${childType};`;
  });

  return `{\n${lines.join("\n")}\n}`;
}

function ensureTsObjectBlock(
  node: Extract<SchemaNode, { kind: "object" }>,
  hint: string,
  ctx: TsEmitContext,
  forcedName?: string
) {
  const existing = ctx.objectNames.get(node as object);
  if (existing) {
    return existing;
  }

  const interfaceName = reserveName(
    ctx.usedNames,
    forcedName ?? formatTypeName(hint || "RootData", ctx.options.namingStyle, ctx.options.prefix, ctx.options.suffix)
  );
  ctx.objectNames.set(node as object, interfaceName);

  const body = emitTsObjectBody(node, hint, ctx);
  const keyword = ctx.options.exportInterfaces ? "export interface" : "interface";
  ctx.objectBlocks.set(interfaceName, `${keyword} ${interfaceName} ${body}`);
  ctx.objectOrder.push(interfaceName);
  return interfaceName;
}

function emitTsType(node: SchemaNode, hint: string, ctx: TsEmitContext): string {
  switch (node.kind) {
    case "string":
      if (shouldUseEnum(node, ctx.options)) {
        return ensureTsEnum(node, hint, ctx);
      }
      return formatSpecialTypeTs(node);
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "unknown":
      return "unknown";
    case "array": {
      const childType = emitTsType(node.element, createChildHint(hint, "items"), ctx);
      return tsNeedsParens(childType) ? `(${childType})[]` : `${childType}[]`;
    }
    case "object":
      return ctx.forceNamedObjects ? ensureTsObjectBlock(node, hint, ctx) : emitTsObjectBody(node, hint, ctx);
    case "union": {
      const parts = unique(node.members.map((member) => emitTsType(member, hint, ctx)));
      return parts.join(" | ");
    }
  }
}

function emitTypeScriptArtifacts(schema: SchemaNode, options: GeneratorOptions, forceNamedObjects: boolean) {
  const ctx = createTsContext(options, forceNamedObjects);
  const rootTypeName = formatTypeName(
    options.rootName || "RootData",
    options.namingStyle,
    options.prefix,
    options.suffix
  );

  let rootAlias = "";

  if (schema.kind === "object") {
    ensureTsObjectBlock(schema, rootTypeName, ctx, rootTypeName);
  } else {
    const keyword = options.exportInterfaces ? "export type" : "type";
    const rootType = emitTsType(schema, rootTypeName, ctx);
    rootAlias = `${keyword} ${rootTypeName} = ${rootType};`;
  }

  const blocks = [
    "// Generated locally by JSON → TypeScript Interface Generator",
    ...ctx.enumOrder.map((name) => ctx.enumBlocks.get(name) ?? ""),
    ...ctx.objectOrder.map((name) => ctx.objectBlocks.get(name) ?? ""),
    rootAlias,
  ].filter(Boolean);

  return {
    code: blocks.join("\n\n"),
    interfaceCount: ctx.objectBlocks.size,
    enumCount: ctx.enumBlocks.size,
    rootTypeName,
    ctx,
  };
}

function emitZodString(node: Extract<SchemaNode, { kind: "string" }>) {
  if (node.values.length >= 2 && node.values.length <= 12) {
    return `z.enum([${node.values.map((value) => JSON.stringify(value)).join(", ")}])`;
  }

  switch (node.specialType) {
    case "email":
      return "z.string().email()";
    case "uuid":
      return "z.string().uuid()";
    case "url":
      return "z.string().url()";
    case "date":
      return "z.string().datetime()";
    case "phone":
      return "z.string().regex(/^\\+?[\\d\\s().-]{7,}$/)";
    default:
      return "z.string()";
  }
}

function createZodContext(options: GeneratorOptions, forceNamedObjects: boolean): ZodEmitContext {
  return {
    options,
    forceNamedObjects,
    usedNames: new Set<string>(),
    schemaNames: new WeakMap<object, string>(),
    schemaBlocks: new Map<string, string>(),
    schemaOrder: [],
  };
}

function ensureZodObjectSchema(
  node: Extract<SchemaNode, { kind: "object" }>,
  hint: string,
  ctx: ZodEmitContext,
  forcedName?: string
) {
  const existing = ctx.schemaNames.get(node as object);
  if (existing) {
    return existing;
  }

  const schemaName = reserveName(
    ctx.usedNames,
    `${forcedName ?? formatTypeName(hint || "RootData", ctx.options.namingStyle, ctx.options.prefix, ctx.options.suffix)}Schema`
  );
  ctx.schemaNames.set(node as object, schemaName);

  const lines = node.properties.map((property) => {
    let emitted = emitZodType(property.node, createChildHint(hint, property.key), ctx);
    if (property.optional) {
      emitted += ".optional()";
    }
    return `  ${formatPropertyName(property.key)}: ${emitted},`;
  });

  ctx.schemaBlocks.set(schemaName, `export const ${schemaName} = z.object({\n${lines.join("\n")}\n});`);
  ctx.schemaOrder.push(schemaName);
  return schemaName;
}

function emitZodType(node: SchemaNode, hint: string, ctx: ZodEmitContext): string {
  switch (node.kind) {
    case "string":
      return emitZodString(node);
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "null":
      return "z.null()";
    case "unknown":
      return "z.unknown()";
    case "array":
      return `z.array(${emitZodType(node.element, createChildHint(hint, "items"), ctx)})`;
    case "union":
      return `z.union([${node.members.map((member) => emitZodType(member, hint, ctx)).join(", ")}])`;
    case "object":
      if (ctx.forceNamedObjects) {
        return ensureZodObjectSchema(node, hint, ctx);
      }
      return `z.object({${node.properties
        .map((property) => {
          let emitted = emitZodType(property.node, createChildHint(hint, property.key), ctx);
          if (property.optional) {
            emitted += ".optional()";
          }
          return `${formatPropertyName(property.key)}: ${emitted}`;
        })
        .join(", ")}})`;
  }
}

function emitZodArtifacts(schema: SchemaNode, options: GeneratorOptions) {
  const ctx = createZodContext(options, options.splitNestedInterfaces);
  const rootTypeName = formatTypeName(
    options.rootName || "RootData",
    options.namingStyle,
    options.prefix,
    options.suffix
  );

  let rootSchemaName = `${rootTypeName}Schema`;
  let rootSchemaBlock = "";

  if (schema.kind === "object") {
    rootSchemaName = ensureZodObjectSchema(schema, rootTypeName, ctx, rootTypeName);
  } else {
    rootSchemaBlock = `export const ${rootSchemaName} = ${emitZodType(schema, rootTypeName, ctx)};`;
  }

  const blocks = [
    "// Generated locally by JSON → TypeScript Interface Generator",
    'import { z } from "zod";',
    ...ctx.schemaOrder.map((name) => ctx.schemaBlocks.get(name) ?? ""),
    rootSchemaBlock,
    `export type ${rootTypeName} = z.infer<typeof ${rootSchemaName}>;`,
  ].filter(Boolean);

  return {
    code: blocks.join("\n\n"),
    interfaceCount: ctx.schemaBlocks.size,
    enumCount: 0,
    rootTypeName,
  };
}

function ensureJsonSchemaDefinitionName(
  node: Extract<SchemaNode, { kind: "object" }>,
  hint: string,
  ctx: JsonSchemaContext,
  forcedName?: string
) {
  const existing = ctx.objectNames.get(node as object);
  if (existing) {
    return existing;
  }

  const name = reserveName(
    ctx.usedNames,
    forcedName ?? formatTypeName(hint || "RootData", ctx.options.namingStyle, ctx.options.prefix, ctx.options.suffix)
  );
  ctx.objectNames.set(node as object, name);
  return name;
}

function emitJsonSchema(node: SchemaNode, hint: string, ctx: JsonSchemaContext, isRoot = false): Record<string, unknown> {
  switch (node.kind) {
    case "string": {
      if (shouldUseEnum(node, ctx.options) || shouldUseLiteralUnion(node)) {
        return { type: "string", enum: node.values };
      }

      const schema: Record<string, unknown> = { type: "string" };
      if (node.specialType === "email") schema.format = "email";
      if (node.specialType === "uuid") schema.format = "uuid";
      if (node.specialType === "url") schema.format = "uri";
      if (node.specialType === "date") schema.format = "date-time";
      if (node.specialType === "phone") schema.pattern = "^\\+?[\\d\\s().-]{7,}$";
      return schema;
    }
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "unknown":
      return {};
    case "array":
      return {
        type: "array",
        items: emitJsonSchema(node.element, createChildHint(hint, "items"), ctx),
      };
    case "union":
      return {
        anyOf: node.members.map((member) => emitJsonSchema(member, hint, ctx)),
      };
    case "object": {
      if (ctx.options.splitNestedInterfaces && !isRoot) {
        const name = ensureJsonSchemaDefinitionName(node, hint, ctx);
        if (!ctx.definitions[name]) {
          ctx.definitions[name] = emitJsonSchema(node, hint, ctx, true);
        }
        return { $ref: `#/definitions/${name}` };
      }

      const required = node.properties.filter((property) => !property.optional).map((property) => property.key);
      const properties = Object.fromEntries(
        node.properties.map((property) => [
          property.key,
          emitJsonSchema(property.node, createChildHint(hint, property.key), ctx),
        ])
      );

      return {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      };
    }
  }
}

function emitJsonSchemaArtifacts(schema: SchemaNode, options: GeneratorOptions) {
  const rootTypeName = formatTypeName(
    options.rootName || "RootData",
    options.namingStyle,
    options.prefix,
    options.suffix
  );

  const ctx: JsonSchemaContext = {
    options,
    usedNames: new Set<string>(),
    objectNames: new WeakMap<object, string>(),
    definitions: {},
  };

  if (schema.kind === "object") {
    ensureJsonSchemaDefinitionName(schema, rootTypeName, ctx, rootTypeName);
  }

  const rootSchema = emitJsonSchema(schema, rootTypeName, ctx, true);
  const document = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: rootTypeName,
    ...rootSchema,
    ...(Object.keys(ctx.definitions).length ? { definitions: ctx.definitions } : {}),
  };

  return {
    code: JSON.stringify(document, null, 2),
    interfaceCount: Object.keys(ctx.definitions).length + (schema.kind === "object" ? 1 : 0),
    enumCount: 0,
    rootTypeName,
  };
}

function collectSpecialHelpers(node: SchemaNode, helpers: Set<Exclude<SpecialType, "none">>) {
  switch (node.kind) {
    case "string":
      if (node.specialType !== "none") {
        helpers.add(node.specialType);
      }
      return;
    case "array":
      collectSpecialHelpers(node.element, helpers);
      return;
    case "object":
      for (const property of node.properties) {
        collectSpecialHelpers(property.node, helpers);
      }
      return;
    case "union":
      for (const member of node.members) {
        collectSpecialHelpers(member, helpers);
      }
      return;
    default:
      return;
  }
}

function emitGuardPrimitiveCheck(
  node: SchemaNode,
  valueExpression: string,
  guardNames: WeakMap<object, string>,
  options: GeneratorOptions
): string {
  switch (node.kind) {
    case "string": {
      const enumCheck = shouldUseEnum(node, options) || shouldUseLiteralUnion(node);
      if (enumCheck) {
        return `typeof ${valueExpression} === "string" && [${node.values
          .map((value) => JSON.stringify(value))
          .join(", ")}].includes(${valueExpression} as string)`;
      }
      switch (node.specialType) {
        case "email":
          return `isEmailString(${valueExpression})`;
        case "uuid":
          return `isUuidString(${valueExpression})`;
        case "url":
          return `isUrlString(${valueExpression})`;
        case "date":
          return `isIsoDateString(${valueExpression})`;
        case "phone":
          return `isPhoneString(${valueExpression})`;
        default:
          return `typeof ${valueExpression} === "string"`;
      }
    }
    case "number":
      return `typeof ${valueExpression} === "number"`;
    case "boolean":
      return `typeof ${valueExpression} === "boolean"`;
    case "null":
      return `${valueExpression} === null`;
    case "unknown":
      return "true";
    case "array":
      return `Array.isArray(${valueExpression}) && ${valueExpression}.every((item) => ${emitGuardPrimitiveCheck(
        node.element,
        "item",
        guardNames,
        options
      )})`;
    case "object": {
      const guardName = guardNames.get(node as object);
      if (guardName) {
        return `is${guardName}(${valueExpression})`;
      }
      return `typeof ${valueExpression} === "object" && ${valueExpression} !== null`;
    }
    case "union":
      return node.members
        .map((member) => `(${emitGuardPrimitiveCheck(member, valueExpression, guardNames, options)})`)
        .join(" || ");
  }
}

function emitSpecialHelpers(helpers: Set<Exclude<SpecialType, "none">>) {
  const blocks: string[] = [];

  if (helpers.has("email")) {
    blocks.push(
      `function isEmailString(value: unknown): value is string {\n  return typeof value === "string" && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value);\n}`
    );
  }
  if (helpers.has("uuid")) {
    blocks.push(
      `function isUuidString(value: unknown): value is string {\n  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);\n}`
    );
  }
  if (helpers.has("url")) {
    blocks.push(
      `function isUrlString(value: unknown): value is string {\n  if (typeof value !== "string") return false;\n  try {\n    const parsed = new URL(value);\n    return Boolean(parsed.protocol && parsed.host);\n  } catch {\n    return false;\n  }\n}`
    );
  }
  if (helpers.has("date")) {
    blocks.push(
      `function isIsoDateString(value: unknown): value is string {\n  return typeof value === "string" && !Number.isNaN(Date.parse(value));\n}`
    );
  }
  if (helpers.has("phone")) {
    blocks.push(
      `function isPhoneString(value: unknown): value is string {\n  return typeof value === "string" && /^\\+?[\\d\\s().-]{7,}$/.test(value);\n}`
    );
  }

  return blocks;
}

function emitTypeGuardArtifacts(schema: SchemaNode, options: GeneratorOptions) {
  const typeArtifacts = emitTypeScriptArtifacts(schema, { ...options, splitNestedInterfaces: true }, true);
  const specialHelpers = new Set<Exclude<SpecialType, "none">>();
  collectSpecialHelpers(schema, specialHelpers);

  const objectNames = typeArtifacts.ctx.objectNames;
  const objectBlocks = typeArtifacts.ctx.objectOrder.map((name) => {
    const targetNode = findObjectNodeByName(schema, name, objectNames);
    if (!targetNode) {
      return "";
    }

    const checks = targetNode.properties.map((property) => {
      const accessor = `obj[${JSON.stringify(property.key)}]`;
      const expression = emitGuardPrimitiveCheck(property.node, accessor, objectNames, options);
      return property.optional ? `(${accessor} === undefined || ${expression})` : expression;
    });

    const body = checks.length ? `  return ${checks.join(" && ")};` : "  return true;";
    return `export function is${name}(value: unknown): value is ${name} {\n  if (typeof value !== "object" || value === null) return false;\n  const obj = value as Record<string, unknown>;\n${body}\n}`;
  });

  const rootGuard =
    schema.kind !== "object"
      ? `export function is${typeArtifacts.rootTypeName}(value: unknown): value is ${typeArtifacts.rootTypeName} {\n  return ${emitGuardPrimitiveCheck(schema, "value", objectNames, options)};\n}`
      : "";

  const blocks = [
    "// Generated locally by JSON → TypeScript Interface Generator",
    typeArtifacts.code,
    ...emitSpecialHelpers(specialHelpers),
    ...objectBlocks.filter(Boolean),
    rootGuard,
  ].filter(Boolean);

  return {
    code: blocks.join("\n\n"),
    interfaceCount: typeArtifacts.interfaceCount,
    enumCount: typeArtifacts.enumCount,
    rootTypeName: typeArtifacts.rootTypeName,
  };
}

function findObjectNodeByName(
  schema: SchemaNode,
  name: string,
  names: WeakMap<object, string>
): Extract<SchemaNode, { kind: "object" }> | null {
  if (schema.kind === "object" && names.get(schema as object) === name) {
    return schema;
  }

  if (schema.kind === "array") {
    return findObjectNodeByName(schema.element, name, names);
  }

  if (schema.kind === "union") {
    for (const member of schema.members) {
      const found = findObjectNodeByName(member, name, names);
      if (found) return found;
    }
  }

  if (schema.kind === "object") {
    for (const property of schema.properties) {
      const found = findObjectNodeByName(property.node, name, names);
      if (found) return found;
    }
  }

  return null;
}

export function generateTypeScriptFromSamples(samples: unknown[], options: GeneratorOptions): GeneratorResult {
  const schema = createRootSchema(samples);
  const result = emitTypeScriptArtifacts(schema, options, options.splitNestedInterfaces);
  return {
    ...result,
    format: "typescript",
  };
}

export function generateOutputFromSamples(
  samples: unknown[],
  options: GeneratorOptions,
  format: OutputFormat
): GeneratorResult {
  const schema = createRootSchema(samples);

  if (format === "typescript") {
    return generateTypeScriptFromSamples(samples, options);
  }

  if (format === "zod") {
    return {
      ...emitZodArtifacts(schema, options),
      format,
    };
  }

  if (format === "typeGuards") {
    return {
      ...emitTypeGuardArtifacts(schema, options),
      format,
    };
  }

  return {
    ...emitJsonSchemaArtifacts(schema, options),
    format,
  };
}

export function generateMockDataFromSamples(samples: unknown[]) {
  const schema = createRootSchema(samples);
  const value = createMockValue(schema);
  return JSON.stringify(value, null, 2);
}

function createMockValue(node: SchemaNode): unknown {
  switch (node.kind) {
    case "string":
      if (node.values.length) return node.values[0];
      switch (node.specialType) {
        case "email":
          return "user@example.com";
        case "uuid":
          return "123e4567-e89b-12d3-a456-426614174000";
        case "url":
          return "https://example.com";
        case "date":
          return "2025-01-01T12:00:00.000Z";
        case "phone":
          return "+1 555 123 4567";
        default:
          return "sample text";
      }
    case "number":
      return 42;
    case "boolean":
      return true;
    case "null":
      return null;
    case "unknown":
      return "value";
    case "array":
      return [createMockValue(node.element)];
    case "object":
      return Object.fromEntries(node.properties.map((property) => [property.key, createMockValue(property.node)]));
    case "union": {
      const preferred = node.members.find((member) => member.kind !== "null") ?? node.members[0];
      return createMockValue(preferred);
    }
  }
}

function detectValueSpecialType(value: string): Exclude<SpecialType, "none"> | null {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "email";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return "uuid";
  if (/^\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return "date";
  try {
    const url = new URL(value);
    if (url.protocol && url.host) return "url";
  } catch {
    // noop
  }
  if (/^\+?[\d\s().-]{7,}$/.test(value)) return "phone";
  return null;
}

function collectFieldStatistics(value: unknown, depth: number, target: FieldStatistics) {
  target.maxDepth = Math.max(target.maxDepth, depth);

  if (value === null) {
    target.typeBreakdown.nulls += 1;
    return;
  }

  if (Array.isArray(value)) {
    target.typeBreakdown.arrays += 1;
    for (const item of value) {
      collectFieldStatistics(item, depth + 1, target);
    }
    return;
  }

  switch (typeof value) {
    case "string": {
      target.typeBreakdown.strings += 1;
      const specialType = detectValueSpecialType(value);
      if (specialType) {
        target.specialTypes[specialType] += 1;
      }
      return;
    }
    case "number":
      target.typeBreakdown.numbers += 1;
      return;
    case "boolean":
      target.typeBreakdown.booleans += 1;
      return;
    case "object": {
      target.typeBreakdown.objects += 1;
      for (const childValue of Object.values(value as Record<string, unknown>)) {
        target.totalFields += 1;
        collectFieldStatistics(childValue, depth + 1, target);
      }
      return;
    }
    default:
      return;
  }
}

export function computeFieldStatistics(samples: unknown[]): FieldStatistics {
  const base: FieldStatistics = {
    totalFields: 0,
    sampleCount: samples.length,
    maxDepth: 1,
    topLevelKeys: [],
    typeBreakdown: {
      strings: 0,
      numbers: 0,
      booleans: 0,
      nulls: 0,
      objects: 0,
      arrays: 0,
    },
    specialTypes: {
      date: 0,
      uuid: 0,
      email: 0,
      url: 0,
      phone: 0,
    },
  };

  const topLevelKeys = new Set<string>();
  for (const sample of samples) {
    collectFieldStatistics(sample, 1, base);
    if (sample && typeof sample === "object" && !Array.isArray(sample)) {
      for (const key of Object.keys(sample as Record<string, unknown>)) {
        topLevelKeys.add(key);
      }
    }
    if (Array.isArray(sample)) {
      for (const entry of sample) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          for (const key of Object.keys(entry as Record<string, unknown>)) {
            topLevelKeys.add(key);
          }
        }
      }
    }
  }

  base.topLevelKeys = [...topLevelKeys].sort((left, right) => left.localeCompare(right));
  return base;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array (${value.length})`;
  if (typeof value === "object") return "object";
  return typeof value;
}

export function buildTreeFromValue(value: unknown, label = "Root", path = "root"): TreeNode {
  if (Array.isArray(value)) {
    const sample = value.find((entry) => entry !== undefined) ?? value[0];
    return {
      id: path,
      label,
      type: describeValue(value),
      children: sample === undefined ? [] : [buildTreeFromValue(sample, "item", `${path}.item`)],
    };
  }

  if (value && typeof value === "object") {
    return {
      id: path,
      label,
      type: "object",
      children: Object.entries(value as Record<string, unknown>).map(([key, child]) =>
        buildTreeFromValue(child, key, `${path}.${key}`)
      ),
    };
  }

  return {
    id: path,
    label,
    type: describeValue(value),
  };
}

export function autoFixJsonInput(input: string): AutoFixResult {
  let fixed = input;
  const changes: string[] = [];

  const original = fixed;

  const withoutUndefined = fixed.replace(/\bundefined\b/g, "null");
  if (withoutUndefined !== fixed) {
    fixed = withoutUndefined;
    changes.push("Converted undefined values to null");
  }

  const withoutTrailingCommas = fixed.replace(/,\s*([}\]])/g, "$1");
  if (withoutTrailingCommas !== fixed) {
    fixed = withoutTrailingCommas;
    changes.push("Removed trailing commas");
  }

  const withQuotedKeys = fixed.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3');
  if (withQuotedKeys !== fixed) {
    fixed = withQuotedKeys;
    changes.push("Added quotes to unquoted object keys");
  }

  const withDoubleQuotes = fixed.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, group: string) => {
    return JSON.stringify(group.replace(/\\'/g, "'"));
  });
  if (withDoubleQuotes !== fixed) {
    fixed = withDoubleQuotes;
    changes.push("Converted single-quoted strings to double quotes");
  }

  if (original === fixed) {
    const parsed = parseJsonInput(input);
    return parsed.ok
      ? { ok: true, fixed: parsed.formatted, changes: ["Input was already valid JSON"] }
      : { ok: false, fixed: input, changes: [], error: parsed.error };
  }

  const parsed = parseJsonInput(fixed);
  if (!parsed.ok) {
    return {
      ok: false,
      fixed,
      changes,
      error: parsed.error,
    };
  }

  return {
    ok: true,
    fixed: parsed.formatted,
    changes,
  };
}

function extractTopLevelJsonValues(input: string) {
  const segments: string[] = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index])) {
      index += 1;
    }

    if (index >= input.length) {
      break;
    }

    const start = index;
    const first = input[index];

    if (first === "{" || first === "[") {
      let depth = 0;
      let inString = false;
      let escaping = false;

      while (index < input.length) {
        const char = input[index];

        if (inString) {
          if (escaping) {
            escaping = false;
          } else if (char === "\\") {
            escaping = true;
          } else if (char === '"') {
            inString = false;
          }
        } else {
          if (char === '"') {
            inString = true;
          } else if (char === "{" || char === "[") {
            depth += 1;
          } else if (char === "}" || char === "]") {
            depth -= 1;
            if (depth === 0) {
              index += 1;
              break;
            }
          }
        }

        index += 1;
      }

      if (depth !== 0) {
        throw new Error("Incomplete JSON structure.");
      }

      segments.push(input.slice(start, index).trim());
      continue;
    }

    while (index < input.length && !/\s/.test(input[index])) {
      index += 1;
    }
    segments.push(input.slice(start, index).trim());
  }

  return segments.filter(Boolean);
}

function formatJsonError(error: unknown) {
  if (error instanceof Error) {
    const lineColumnMatch = error.message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (lineColumnMatch) {
      return `Invalid JSON at line ${lineColumnMatch[1]}, column ${lineColumnMatch[2]}: ${error.message}`;
    }
    return `Invalid JSON: ${error.message}`;
  }
  return "Invalid JSON: Unable to parse the provided content.";
}

export function parseJsonInput(input: string): ParseResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return {
      ok: false,
      error: "Paste JSON to generate output.",
    };
  }

  try {
    const value = JSON.parse(trimmed) as unknown;
    return {
      ok: true,
      mode: "single",
      value,
      samples: [value],
      formatted: JSON.stringify(value, null, 2),
    };
  } catch (error) {
    try {
      const segments = extractTopLevelJsonValues(trimmed);
      if (segments.length <= 1) {
        return {
          ok: false,
          error: formatJsonError(error),
        };
      }

      const samples = segments.map((segment) => JSON.parse(segment) as unknown);
      return {
        ok: true,
        mode: "multiple",
        value: samples,
        samples,
        formatted: samples.map((sample) => JSON.stringify(sample, null, 2)).join("\n\n"),
      };
    } catch (secondaryError) {
      return {
        ok: false,
        error: formatJsonError(secondaryError instanceof Error ? secondaryError : error),
      };
    }
  }
}

export function formatJsonInput(input: string) {
  const result = parseJsonInput(input);
  if (!result.ok) {
    return result;
  }

  return {
    ok: true as const,
    formatted: result.formatted,
  };
}
