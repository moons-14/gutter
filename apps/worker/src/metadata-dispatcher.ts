import {
  lookupSidecar,
  metadataProtocolVersion,
  type LookupRequest,
  type LookupResponse,
} from '@gutter/metadata-provider';
import { recordMetadataCandidate } from '@gutter/db';
import { metadataProviderConfig, type MetadataProviderConfig } from '@gutter/config';

type Lookup = typeof lookupSidecar;
type RecordCandidate = typeof recordMetadataCandidate;

export async function dispatchConfiguredSidecars(
  config: MetadataProviderConfig,
  rootId: string,
  canonicalIdentity: string,
  request: LookupRequest,
  signal: AbortSignal | undefined,
  lookup: Lookup = lookupSidecar,
  record: RecordCandidate = recordMetadataCandidate,
): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const sidecar = config.sidecars[next++];
      if (!sidecar) return;
      let response: LookupResponse | undefined;
      for (let attempt = 0; attempt <= config.retries; attempt++) {
        try {
          response = await lookup(sidecar.endpoint, request, {
            token: sidecar.token,
            timeoutMs: config.timeoutMs,
            payloadBytes: config.payloadBytes,
            signal,
          });
          break;
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
      // Failed sidecars never write and cannot change candidates from another sidecar.
      if (!response) continue;
      for (const candidate of response.candidates)
        await record(rootId, canonicalIdentity, {
          ...candidate,
          providerId: sidecar.id,
          providerPriority: sidecar.priority,
          configOrder: sidecar.order,
        });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(config.concurrency, config.sidecars.length) }, run),
  );
}

/** Invoked only by worker-owned jobs. Requests contain no source paths, root names, or settings. */
export async function dispatchMetadataLookup(
  rootId: string,
  canonicalIdentity: string,
  searchTerms: readonly string[],
  publicIds: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const config = await metadataProviderConfig();
  const request: LookupRequest = {
    version: metadataProtocolVersion,
    canonicalIdentity,
    searchTerms: [
      ...new Set(
        searchTerms.filter((term) => /^[\p{L}\p{N}][\p{L}\p{N} .,'’!&:;()/_-]{0,127}$/u.test(term)),
      ),
    ].slice(0, 8),
    publicIds: [
      ...new Set(
        publicIds.filter((id) =>
          /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(id),
        ),
      ),
    ].slice(0, 8),
  };
  await dispatchConfiguredSidecars(config, rootId, canonicalIdentity, request, signal);
}
