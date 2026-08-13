import assert from 'node:assert/strict';

export function classifyCapability(error, capability) {
  const code = error?.code;
  const unavailable =
    code === 'ENOSPC' ||
    code === 'EOPNOTSUPP' ||
    code === 'ENOTSUP' ||
    (error?.name === 'DockerUnavailable' && capability === 'docker') ||
    (error?.name === 'PostgresUnavailable' && capability === 'postgres');
  return unavailable
    ? { status: 'unavailable', reason: `${capability}:${code ?? error?.name ?? 'unsupported'}` }
    : { status: 'fail', reason: `${capability}:${code ?? error?.name ?? 'failure'}` };
}

assert.deepEqual(classifyCapability({ code: 'EOPNOTSUPP' }, 'sparse'), {
  status: 'unavailable',
  reason: 'sparse:EOPNOTSUPP',
});
assert.deepEqual(classifyCapability({ name: 'DockerUnavailable' }, 'docker'), {
  status: 'unavailable',
  reason: 'docker:DockerUnavailable',
});
assert.deepEqual(classifyCapability({ code: '23505' }, 'postgres'), {
  status: 'fail',
  reason: 'postgres:23505',
});
console.log('SCALE_CAPABILITY_RESULT pass');
