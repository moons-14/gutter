import assert from 'node:assert/strict';
import { classifyCapability } from '../scripts/scale-capability.mjs';
export { classifyCapability };

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
assert.deepEqual(classifyCapability(new Error('assertion'), 'oracle'), {
  status: 'fail',
  reason: 'oracle:Error',
});
console.log('SCALE_CAPABILITY_RESULT pass');
