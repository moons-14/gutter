import { readFile } from 'node:fs/promises';

const [basePath, candidatePath, servedPath] = process.argv.slice(2);
if (!basePath || !candidatePath) process.exit(2);
let parseYaml;
try {
  ({ parse: parseYaml } = await import('yaml'));
} catch {
  ({ parse: parseYaml } =
    await import('../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js'));
}
const load = async (path) => {
  const text = await readFile(path, 'utf8');
  return path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
};
const base = await load(basePath);
const candidate = await load(candidatePath);
const failures = [];
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const pointer = (document, ref) => {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let value = document;
  for (const encoded of ref.slice(2).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !(key in value)) return undefined;
    value = value[key];
  }
  return value;
};
const deref = (document, value) => {
  let current = value;
  const seen = new Set();
  while (current?.$ref) {
    if (seen.has(current.$ref)) return current;
    seen.add(current.$ref);
    const resolved = pointer(document, current.$ref);
    if (resolved === undefined) return current;
    current = resolved;
  }
  return current;
};
const identity = (document, parameter) => {
  const resolved = deref(document, parameter);
  return `${resolved?.in ?? ''}:${resolved?.name ?? ''}`;
};
const keys = new Set([
  'type',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'format',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'pattern',
]);
const canonical = (value) =>
  value && typeof value === 'object'
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
    : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const compareSchema = (beforeRaw, afterRaw, path) => {
  const before = deref(base, beforeRaw);
  const after = deref(candidate, afterRaw);
  if (!before || !after) {
    if (before && !after) failures.push(`removed ${path}`);
    return;
  }
  for (const key of keys) {
    if (before[key] !== undefined && !equal(before[key], after[key]))
      failures.push(`changed ${key} ${path}`);
  }
  for (const name of before.required ?? [])
    if (!after.required?.includes(name)) failures.push(`removed required field ${path}.${name}`);
  for (const name of after.required ?? [])
    if (!(before.required ?? []).includes(name) && before.properties?.[name])
      failures.push(`optional field became required ${path}.${name}`);
  if (before.enum)
    for (const value of before.enum)
      if (!after.enum?.some((v) => equal(v, value)))
        failures.push(`removed enum ${path}=${JSON.stringify(value)}`);
  for (const [name, schema] of Object.entries(before.properties ?? {})) {
    if (!after.properties?.[name]) failures.push(`removed property ${path}.${name}`);
    else compareSchema(schema, after.properties[name], `${path}.${name}`);
  }
  if (before.items) compareSchema(before.items, after.items, `${path}[]`);
  for (const branch of before.anyOf ?? []) {
    const match = (after.anyOf ?? []).find((value) =>
      branch.$ref && value.$ref
        ? branch.$ref === value.$ref
        : equal(deref(candidate, value), deref(base, branch)),
    );
    compareSchema(branch, match, `${path}.anyOf`);
  }
  for (const branch of before.oneOf ?? []) {
    const match = (after.oneOf ?? []).find((value) =>
      branch.$ref && value.$ref
        ? branch.$ref === value.$ref
        : equal(deref(candidate, value), deref(base, branch)),
    );
    compareSchema(branch, match, `${path}.oneOf`);
  }
};
const compareContent = (before, after, path) => {
  for (const [media, content] of Object.entries(before ?? {})) {
    if (!after?.[media]) failures.push(`removed media ${path} ${media}`);
    else compareSchema(content.schema, after[media].schema, `${path} ${media}`);
  }
};
const compareHeaders = (before, after, path) => {
  for (const [name, header] of Object.entries(before ?? {})) {
    const candidateHeader = after?.[name];
    if (!candidateHeader) {
      failures.push(`removed response header ${path} ${name}`);
      continue;
    }
    const resolvedHeader = deref(base, header);
    const resolvedCandidateHeader = deref(candidate, candidateHeader);
    if (Boolean(resolvedHeader.required) !== Boolean(resolvedCandidateHeader.required))
      failures.push(`changed response header requiredness ${path} ${name}`);
    compareSchema(resolvedHeader.schema, resolvedCandidateHeader.schema, `${path} header ${name}`);
  }
};
const compareOperation = (before, after, path) => {
  if (!after) {
    failures.push(`removed operation ${path}`);
    return;
  }
  const bp = new Map((before.parameters ?? []).map((p) => [identity(base, p), p]));
  const ap = new Map((after.parameters ?? []).map((p) => [identity(candidate, p), p]));
  for (const [key, parameter] of bp) {
    const candidateParameter = ap.get(key);
    if (!candidateParameter) failures.push(`removed parameter ${path} ${key}`);
    else {
      if (
        Boolean(deref(base, parameter).required) !==
        Boolean(deref(candidate, candidateParameter).required)
      )
        failures.push(`changed required parameter ${path} ${key}`);
      compareSchema(
        deref(base, parameter).schema,
        deref(candidate, candidateParameter).schema,
        `${path} parameter ${key}`,
      );
    }
  }
  for (const [key, parameter] of ap) {
    if (!bp.has(key) && deref(candidate, parameter).required)
      failures.push(`added required parameter ${path} ${key}`);
  }
  if (before.requestBody) {
    if (!after.requestBody) failures.push(`removed request body ${path}`);
    else {
      if (deref(base, before.requestBody).required && !deref(candidate, after.requestBody).required)
        failures.push(`request body became optional ${path}`);
      if (!deref(base, before.requestBody).required && deref(candidate, after.requestBody).required)
        failures.push(`request body became required ${path}`);
      compareContent(
        deref(base, before.requestBody).content,
        deref(candidate, after.requestBody).content,
        `${path} request body`,
      );
    }
  } else if (after.requestBody && deref(candidate, after.requestBody).required) {
    failures.push(`added required request body ${path}`);
  }
  for (const [status, response] of Object.entries(before.responses ?? {})) {
    const candidateResponse = after.responses?.[status];
    if (!candidateResponse) failures.push(`removed response ${path} ${status}`);
    else {
      compareContent(
        deref(base, response).content,
        deref(candidate, candidateResponse).content,
        `${path} response ${status}`,
      );
      compareHeaders(
        deref(base, response).headers,
        deref(candidate, candidateResponse).headers,
        `${path} ${status}`,
      );
    }
  }
};
for (const [path, item] of Object.entries(base.paths ?? {}))
  for (const method of methods)
    if (item[method])
      compareOperation(item[method], candidate.paths?.[path]?.[method], `${path} ${method}`);
for (const [name, schema] of Object.entries(base.components?.schemas ?? {}))
  compareSchema(schema, candidate.components?.schemas?.[name], `components.schemas.${name}`);
for (const [name, parameter] of Object.entries(base.components?.parameters ?? {})) {
  const candidateParameter = candidate.components?.parameters?.[name];
  if (!candidateParameter) failures.push(`removed components.parameters.${name}`);
  else {
    if (
      Boolean(deref(base, parameter).required) !==
      Boolean(deref(candidate, candidateParameter).required)
    )
      failures.push(`changed required components.parameters.${name}`);
    compareSchema(
      deref(base, parameter).schema,
      deref(candidate, candidateParameter).schema,
      `components.parameters.${name}`,
    );
  }
}
for (const [name, body] of Object.entries(base.components?.requestBodies ?? {})) {
  const candidateBody = candidate.components?.requestBodies?.[name];
  if (!candidateBody) failures.push(`removed components.requestBodies.${name}`);
  else {
    if (Boolean(deref(base, body).required) !== Boolean(deref(candidate, candidateBody).required))
      failures.push(`changed required components.requestBodies.${name}`);
    compareContent(
      deref(base, body).content,
      deref(candidate, candidateBody).content,
      `components.requestBodies.${name}`,
    );
  }
}
for (const [name, header] of Object.entries(base.components?.headers ?? {})) {
  const candidateHeader = candidate.components?.headers?.[name];
  if (!candidateHeader) failures.push(`removed components.headers.${name}`);
  else compareHeaders({ [name]: header }, { [name]: candidateHeader }, 'components.headers');
}
for (const [name, response] of Object.entries(base.components?.responses ?? {})) {
  const candidateResponse = candidate.components?.responses?.[name];
  if (!candidateResponse) failures.push(`removed components.responses.${name}`);
  else {
    compareContent(
      deref(base, response).content,
      deref(candidate, candidateResponse).content,
      `components.responses.${name}`,
    );
    compareHeaders(
      deref(base, response).headers,
      deref(candidate, candidateResponse).headers,
      `components.responses.${name}`,
    );
  }
}
for (const section of ['securitySchemes'])
  for (const [name, value] of Object.entries(base.components?.[section] ?? {}))
    if (!candidate.components?.[section]?.[name])
      failures.push(`removed components.${section}.${name}`);
if (servedPath) {
  const served = await load(servedPath);
  if (JSON.stringify(canonical(candidate)) !== JSON.stringify(canonical(served)))
    failures.push('served OpenAPI JSON differs from source contract');
}
if (failures.length) {
  console.error(`Breaking public API change:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `OpenAPI compatibility OK (${Object.entries(candidate.paths ?? {}).flatMap(([p, i]) => Object.keys(i).filter((m) => methods.has(m))).length} operations; structural diff complete)`,
);
