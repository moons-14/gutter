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
const operationKeys = (document) =>
  Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => methods.has(method))
      .map((method) => `${path} ${method}`),
  );
for (const key of operationKeys(base)) {
  const [path, method] = key.split(' ');
  if (!candidate.paths?.[path]?.[method]) failures.push(`removed operation ${key}`);
}
const identity = (parameter) => parameter.$ref ?? `${parameter.in ?? ''}:${parameter.name ?? ''}`;
const compareSchema = (before, after, path) => {
  if (!before || !after) {
    if (before && !after) failures.push(`removed ${path}`);
    return;
  }
  if (before.enum) {
    for (const value of before.enum)
      if (
        !after.enum?.some(
          (candidateValue) => JSON.stringify(candidateValue) === JSON.stringify(value),
        )
      )
        failures.push(`removed enum value ${path}=${JSON.stringify(value)}`);
  }
  if (before.required) {
    for (const name of before.required)
      if (!after.required?.includes(name)) failures.push(`removed required field ${path}.${name}`);
  }
  if (before.properties) {
    for (const [name, schema] of Object.entries(before.properties)) {
      if (!after.properties?.[name]) failures.push(`removed property ${path}.${name}`);
      else compareSchema(schema, after.properties[name], `${path}.${name}`);
    }
  }
  if (before.items) compareSchema(before.items, after.items, `${path}[]`);
  for (const branch of before.anyOf ?? []) {
    const equivalent = (after.anyOf ?? []).some(
      (candidateBranch) => JSON.stringify(candidateBranch) === JSON.stringify(branch),
    );
    if (!equivalent && branch.$ref)
      compareSchema(
        branch,
        (after.anyOf ?? []).find((item) => item.$ref === branch.$ref),
        path,
      );
  }
};
const compareOperation = (before, after, path) => {
  const beforeParameters = new Map(
    (before.parameters ?? []).map((parameter) => [identity(parameter), parameter]),
  );
  const afterParameters = new Map(
    (after.parameters ?? []).map((parameter) => [identity(parameter), parameter]),
  );
  for (const [key, parameter] of beforeParameters) {
    if (!afterParameters.has(key)) failures.push(`removed parameter ${path} ${key}`);
    else if (parameter.schema)
      compareSchema(parameter.schema, afterParameters.get(key).schema, `${path} parameter ${key}`);
  }
  for (const [key, parameter] of afterParameters) {
    if (!beforeParameters.has(key) && parameter.required)
      failures.push(`added required parameter ${path} ${key}`);
  }
  if (before.requestBody) {
    if (!after.requestBody) failures.push(`removed request body ${path}`);
    else {
      const beforeContent = before.requestBody.content ?? {};
      const afterContent = after.requestBody.content ?? {};
      for (const [media, content] of Object.entries(beforeContent)) {
        if (!afterContent[media]) failures.push(`removed request body media ${path} ${media}`);
        else
          compareSchema(
            content.schema,
            afterContent[media].schema,
            `${path} request body ${media}`,
          );
      }
    }
  }
  const beforeResponses = before.responses ?? {};
  const afterResponses = after.responses ?? {};
  for (const [status, response] of Object.entries(beforeResponses)) {
    if (!afterResponses[status]) failures.push(`removed response ${path} ${status}`);
    else {
      const beforeContent = response.content ?? {};
      const afterContent = afterResponses[status].content ?? {};
      for (const [media, content] of Object.entries(beforeContent)) {
        if (!afterContent[media])
          failures.push(`removed response media ${path} ${status} ${media}`);
        else
          compareSchema(
            content.schema,
            afterContent[media].schema,
            `${path} response ${status} ${media}`,
          );
      }
    }
  }
};
for (const [path, item] of Object.entries(base.paths ?? {})) {
  for (const method of methods)
    if (item[method])
      compareOperation(item[method], candidate.paths?.[path]?.[method] ?? {}, `${path} ${method}`);
}
for (const [name, schema] of Object.entries(base.components?.schemas ?? {}))
  compareSchema(schema, candidate.components?.schemas?.[name], `components.schemas.${name}`);
if (servedPath) {
  const served = await load(servedPath);
  if (JSON.stringify(candidate) !== JSON.stringify(served))
    failures.push('served OpenAPI JSON differs from source contract');
}
if (failures.length) {
  console.error(`Breaking public API change:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `OpenAPI compatibility OK (${operationKeys(candidate).length} operations; structural diff complete)`,
);
