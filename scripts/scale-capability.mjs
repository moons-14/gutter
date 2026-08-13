const unsupportedCodes = new Set(['ENOSPC', 'EOPNOTSUPP', 'ENOTSUP']);
export function classifyCapability(error, capability) {
  const code = error?.code;
  const unavailable = unsupportedCodes.has(code) ||
    (error?.name === 'DockerUnavailable' && capability === 'docker') ||
    (error?.name === 'PostgresUnavailable' && capability === 'postgres');
  return unavailable
    ? { status: 'unavailable', reason: `${capability}:${code ?? error?.name ?? 'unsupported'}` }
    : { status: 'fail', reason: `${capability}:${code ?? error?.name ?? 'failure'}` };
}
