# Worker

M0 starts pg-boss only after real database/schema readiness. Task registration is intentionally
empty; future scanning must preserve read-only library semantics and worker-only mounts.
