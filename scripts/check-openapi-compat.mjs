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
  if (!value?.$ref) return value;
  return pointer(document, value.$ref) ?? value;
};
const identity = (parameter) => parameter.$ref ?? `${parameter.in ?? ''}:${parameter.name ?? ''}`;
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
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
const compareOperation = (before, after, path) => {
  if (!after) {
    failures.push(`removed operation ${path}`);
    return;
  }
  const bp = new Map((before.parameters ?? []).map((p) => [identity(p), p]));
  const ap = new Map((after.parameters ?? []).map((p) => [identity(p), p]));
  for (const [key, parameter] of bp) {
    const candidateParameter = ap.get(key);
    if (!candidateParameter) failures.push(`removed parameter ${path} ${key}`);
    else {
      if (parameter.required !== undefined && parameter.required !== candidateParameter.required)
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
      compareContent(
        deref(base, before.requestBody).content,
        deref(candidate, after.requestBody).content,
        `${path} request body`,
      );
    }
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
      for (const [name, header] of Object.entries(deref(base, response).headers ?? {})) {
        const candidateHeader = deref(candidate, candidateResponse).headers?.[name];
        if (!candidateHeader) failures.push(`removed response header ${path} ${status} ${name}`);
        else if (header.required && !candidateHeader.required)
          failures.push(`response header became optional ${path} ${status} ${name}`);
      }
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
    if (parameter.required !== undefined && parameter.required !== candidateParameter.required)
      failures.push(`changed required components.parameters.${name}`);
    compareSchema(
      deref(base, parameter).schema,
      deref(candidate, candidateParameter).schema,
      `components.parameters.${name}`,
    );
  }
}
for (const [name, response] of Object.entries(base.components?.responses ?? {})) {
  const candidateResponse = candidate.components?.responses?.[name];
  if (!candidateResponse) failures.push(`removed components.responses.${name}`);
  else
    compareContent(
      deref(base, response).content,
      deref(candidate, candidateResponse).content,
      `components.responses.${name}`,
    );
}
for (const section of ['securitySchemes'])
  for (const [name, value] of Object.entries(base.components?.[section] ?? {}))
    if (!candidate.components?.[section]?.[name])
      failures.push(`removed components.${section}.${name}`);
if (servedPath) {
  const served = await load(servedPath);
  if (!equal(candidate, served)) failures.push('served OpenAPI JSON differs from source contract');
}
if (failures.length) {
  console.error(`Breaking public API change:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `OpenAPI compatibility OK (${Object.entries(candidate.paths ?? {}).flatMap(([p, i]) => Object.keys(i).filter((m) => methods.has(m))).length} operations; structural diff complete)`,
);
