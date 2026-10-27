/**
 * zod (v3) schemas to JSON Schema, for the Settings forms.
 *
 * Lair's config parsers use zod 3 (`zod@3.25`, whose classic schemas the
 * zod 4 `z.toJSONSchema` does not read), so this covers the features they
 * use: objects (strict, passthrough, catchall), records, arrays, unions,
 * discriminated unions, intersections, enums, literals, strings and numbers
 * with their checks, defaults, optionals, nullables, refinements and
 * transforms (shown as their input type, marked x-refined), preprocess,
 * pipelines, lazy, catch, branded and readonly. Anything else becomes `{}`
 * (any value), which the forms edit as YAML.
 */
import type { ZodTypeAny } from "zod";
import type { JsonSchema } from "../../shared/settings-types.js";

interface Def {
  typeName?: string;
  description?: string;
  [key: string]: unknown;
}

interface Check {
  kind: string;
  value?: unknown;
  inclusive?: boolean;
  regex?: RegExp;
}

function defOf(schema: ZodTypeAny): Def {
  return (schema as unknown as { _def: Def })._def ?? {};
}

function inner(def: Def, key: string): ZodTypeAny {
  return def[key] as ZodTypeAny;
}

/** A plain copy of a default value (defaults may be shared objects). */
function plain(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

function literalType(value: unknown): JsonSchema["type"] | undefined {
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return value === null ? "null" : undefined;
  }
}

function stringSchema(def: Def): JsonSchema {
  const out: JsonSchema = { type: "string" };
  for (const check of (def.checks as Check[] | undefined) ?? []) {
    switch (check.kind) {
      case "min":
        out.minLength = check.value as number;
        break;
      case "max":
        out.maxLength = check.value as number;
        break;
      case "length":
        out.minLength = check.value as number;
        out.maxLength = check.value as number;
        break;
      case "regex":
        if (check.regex) out.pattern = check.regex.source;
        break;
      case "url":
        out.format = "uri";
        break;
      case "email":
        out.format = "email";
        break;
      case "uuid":
        out.format = "uuid";
        break;
      case "datetime":
        out.format = "date-time";
        break;
    }
  }
  return out;
}

function numberSchema(def: Def): JsonSchema {
  const out: JsonSchema = { type: "number" };
  for (const check of (def.checks as Check[] | undefined) ?? []) {
    const value = check.value as number;
    switch (check.kind) {
      case "int":
        out.type = "integer";
        break;
      case "min":
        if (check.inclusive) out.minimum = value;
        else out.exclusiveMinimum = value;
        break;
      case "max":
        if (check.inclusive) out.maximum = value;
        else out.exclusiveMaximum = value;
        break;
      case "multipleOf":
        out.multipleOf = value;
        break;
    }
  }
  return out;
}

function isOptional(schema: ZodTypeAny): boolean {
  try {
    return schema.isOptional();
  } catch {
    return false;
  }
}

function convert(schema: ZodTypeAny, path: Set<ZodTypeAny>): JsonSchema {
  const def = defOf(schema);
  switch (def.typeName) {
    case "ZodString":
      return stringSchema(def);
    case "ZodNumber":
      return numberSchema(def);
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodNull":
      return { type: "null" };
    case "ZodLiteral": {
      const type = literalType(def.value);
      return type ? { type, const: def.value } : { const: def.value };
    }
    case "ZodEnum":
      return { type: "string", enum: [...(def.values as string[])] };
    case "ZodNativeEnum": {
      const values = Object.values(def.values as Record<string, string | number>);
      // A numeric TypeScript enum maps names to numbers and numbers back to names
      const numbers = values.filter((v) => typeof v === "number");
      return { enum: numbers.length > 0 ? numbers : values };
    }
    case "ZodArray": {
      const out: JsonSchema = { type: "array", items: toJsonSchema(inner(def, "type"), path) };
      const min = def.minLength as { value: number } | null;
      const max = def.maxLength as { value: number } | null;
      const exact = def.exactLength as { value: number } | null;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      if (exact) {
        out.minItems = exact.value;
        out.maxItems = exact.value;
      }
      return out;
    }
    case "ZodSet":
      return { type: "array", uniqueItems: true, items: toJsonSchema(inner(def, "valueType"), path) };
    case "ZodTuple":
      return { type: "array" };
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value, path);
        if (!isOptional(value)) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length > 0) out.required = required;
      const catchall = inner(def, "catchall");
      if (catchall && defOf(catchall).typeName !== "ZodNever") {
        out.additionalProperties = toJsonSchema(catchall, path);
      } else if (def.unknownKeys === "strict") {
        out.additionalProperties = false;
      } else if (def.unknownKeys === "passthrough") {
        out.additionalProperties = true;
      }
      return out;
    }
    case "ZodRecord":
    case "ZodMap": {
      const out: JsonSchema = { type: "object", additionalProperties: toJsonSchema(inner(def, "valueType"), path) };
      const keys = toJsonSchema(inner(def, "keyType"), path);
      if (keys.pattern || keys.enum) out.propertyNames = keys;
      return out;
    }
    case "ZodUnion": {
      const options = (def.options as ZodTypeAny[]).map((o) => toJsonSchema(o, path));
      if (options.length > 0 && options.every((o) => o.const !== undefined)) {
        return { enum: options.map((o) => o.const) };
      }
      return { anyOf: options };
    }
    case "ZodDiscriminatedUnion":
      return {
        oneOf: (def.options as ZodTypeAny[]).map((o) => toJsonSchema(o, path)),
        discriminator: { propertyName: def.discriminator as string },
      };
    case "ZodIntersection":
      return { allOf: [toJsonSchema(inner(def, "left"), path), toJsonSchema(inner(def, "right"), path)] };
    case "ZodOptional":
    case "ZodCatch":
    case "ZodReadonly":
      return toJsonSchema(inner(def, "innerType"), path);
    case "ZodBranded":
      return toJsonSchema(inner(def, "type"), path);
    case "ZodNullable":
      return { anyOf: [toJsonSchema(inner(def, "innerType"), path), { type: "null" }] };
    case "ZodDefault":
      return { ...toJsonSchema(inner(def, "innerType"), path), default: plain((def.defaultValue as () => unknown)()) };
    case "ZodEffects":
      return { ...toJsonSchema(inner(def, "schema"), path), "x-refined": true };
    case "ZodPipeline":
      return toJsonSchema(inner(def, "in"), path);
    case "ZodLazy":
      return toJsonSchema((def.getter as () => ZodTypeAny)(), path);
    default:
      // ZodAny, ZodUnknown, and types a config never holds (functions, promises, dates)
      return {};
  }
}

/**
 * The JSON Schema of a zod schema. A schema that refers to itself (z.lazy)
 * becomes `{}` where it recurses.
 */
export function toJsonSchema(schema: ZodTypeAny, path: Set<ZodTypeAny> = new Set()): JsonSchema {
  if (path.has(schema)) return {};
  path.add(schema);
  try {
    const out = convert(schema, path);
    const description = defOf(schema).description;
    if (description && !out.description) out.description = description;
    return out;
  } finally {
    path.delete(schema);
  }
}
