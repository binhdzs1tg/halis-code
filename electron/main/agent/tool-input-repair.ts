/**
 * Schema-guided repair of malformed tool arguments: weaker models routinely
 * emit {"limit": "20"}, stringified
 * JSON or null placeholders for optional fields. Instead of failing the call,
 * the input is coerced against the tool's own JSON schema — but only where
 * the fix is unambiguous. Pure logic so the smoke tests can run it in Node.
 */

/** Repairs deeper than this are almost certainly chasing a broken schema. */
const MAX_DEPTH = 6

type Schema = Record<string, unknown>

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** The schema's declared types, with the string and array spellings unified. */
function typesOf(schema: Schema): string[] {
  const type = schema.type
  if (typeof type === 'string') return [type]
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === 'string')
  return []
}

/**
 * Resolve a local `$ref` against the document root. Only `#/$defs/...` and
 * `#/definitions/...` pointers are followed; remote documents are left alone.
 */
function deref(schema: Schema, root: Schema): Schema {
  let current = schema
  for (let hops = 0; hops < MAX_DEPTH; hops += 1) {
    const ref = current.$ref
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return current
    const segments = ref.slice(2).split('/').map((segment) =>
      segment.replace(/~1/g, '/').replace(/~0/g, '~')
    )
    let target: unknown = root
    for (const segment of segments) {
      target = isRecord(target) ? target[segment] : undefined
      if (target === undefined) break
    }
    if (!isSchema(target)) return current
    current = target
  }
  return current
}

/**
 * `anyOf`/`oneOf` with exactly one non-null candidate: repair against it,
 * but only when the value's own type matches none of the candidates — a
 * value that already fits is not ours to second-guess.
 */
function singleBranch(schema: Schema, value: unknown): Schema | null {
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key]
    if (!Array.isArray(options)) continue
    const candidates = options.filter(isSchema)
    const nonNull = candidates.filter((option) => !typesOf(option).includes('null'))
    if (nonNull.length !== 1) continue
    const valueType =
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const matchesSome = candidates.some((option) => typesOf(option).includes(valueType))
    if (!matchesSome) return nonNull[0] ?? null
  }
  return null
}

/**
 * Repair one value against one schema node. Anything the schema cannot
 * explain passes through untouched — repair never invents data.
 */
function repairValue(value: unknown, schema: unknown, root: Schema, depth: number): unknown {
  if (depth > MAX_DEPTH || !isSchema(schema)) return value
  const resolved = deref(schema, root)
  const branch = singleBranch(resolved, value)
  if (branch) return repairValue(value, branch, root, depth + 1)

  const types = typesOf(resolved)

  if (types.includes('object')) {
    let candidate = value
    if (typeof candidate === 'string') {
      const parsed = parseJson(candidate)
      if (isRecord(parsed)) candidate = parsed
    }
    if (isRecord(candidate)) return repairObject(candidate, resolved, root, depth + 1)
  }

  if (types.includes('array')) {
    let candidate = value
    if (typeof candidate === 'string') {
      const parsed = parseJson(candidate)
      if (Array.isArray(parsed)) candidate = parsed
    }
    if (Array.isArray(candidate)) {
      const items = resolved.items
      if (Array.isArray(items)) {
        // Positional tuple: each slot repairs against its own schema.
        return candidate.map((item, index) =>
          index < items.length ? repairValue(item, items[index], root, depth + 1) : item
        )
      }
      if (isSchema(items)) {
        return candidate.map((item) => repairValue(item, items, root, depth + 1))
      }
      return candidate
    }
    if (isSchema(resolved.items) && value !== null && value !== undefined) {
      // A lone compatible item stands in for the whole array.
      const itemType = typesOf(resolved.items)
      const valueType = typeof value
      if (
        (itemType.includes('string') && valueType === 'string') ||
        (itemType.includes('number') && valueType === 'number') ||
        (itemType.includes('boolean') && valueType === 'boolean')
      ) {
        return [value]
      }
    }
  }

  if (types.includes('number') || types.includes('integer')) {
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      const parsed = Number(value)
      return types.includes('integer') && !types.includes('number') ? Math.trunc(parsed) : parsed
    }
  }

  if (types.includes('boolean')) {
    if (value === 'true') return true
    if (value === 'false') return false
  }

  return value
}

/** True for a plain single-type property — the only kind placeholders may hide in. */
function plainSingleType(schema: Schema): boolean {
  const types = typesOf(schema)
  return types.length === 1 && types[0] !== 'null' && types[0] !== undefined
}

/**
 * Optional properties carrying a null or empty-object placeholder are really
 * absent: the model had nothing to say and padded the slot.
 */
function isPlaceholder(value: unknown, property: Schema): boolean {
  if (!plainSingleType(property)) return false
  if (value === null) return true
  return isRecord(value) && Object.keys(value).length === 0 && typesOf(property).includes('object')
}

function repairObject(
  value: Record<string, unknown>,
  schema: Schema,
  root: Schema,
  depth: number
): Record<string, unknown> {
  const properties = isSchema(schema.properties) ? schema.properties : {}
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
  )
  // Extra keys disappear only on a genuinely closed object: an explicit
  // additionalProperties:false with no pattern properties or composition.
  const closed =
    schema.additionalProperties === false &&
    schema.patternProperties === undefined &&
    schema.anyOf === undefined &&
    schema.oneOf === undefined &&
    schema.allOf === undefined
  const valueSchema = isSchema(schema.additionalProperties) ? schema.additionalProperties : null

  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    const property = isSchema(properties[key]) ? properties[key] : null
    if (property) {
      if (!required.has(key) && isPlaceholder(raw, property)) continue
      out[key] = repairValue(raw, property, root, depth)
      continue
    }
    if (closed) continue
    if (valueSchema) {
      out[key] = repairValue(raw, valueSchema, root, depth)
      continue
    }
    out[key] = raw
  }
  return out
}

/**
 * Repair a tool call's input against the tool's parameter schema. The input
 * is returned unchanged when the schema is missing or not an object, when
 * the input came wrapped in the provider layer's `_malformed` marker (its
 * `_raw` payload gets one chance to parse), or when nothing needs fixing.
 */
export function repairToolInput(input: Record<string, unknown>, schema: unknown): Record<string, unknown> {
  let candidate = input
  if (candidate._malformed === true && typeof candidate._raw === 'string') {
    const parsed = parseJson(candidate._raw)
    if (isRecord(parsed)) candidate = parsed
  }
  if (!isSchema(schema) || schema.type !== 'object') return candidate
  const root = schema
  const repaired = repairObject(candidate, root, root, 0)
  return repaired
}
