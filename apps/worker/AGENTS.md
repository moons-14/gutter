# Worker

M1 validates immutable configured roots in the worker mount namespace and snapshots their state in
PostgreSQL before pg-boss starts. Task registration and scanning remain intentionally empty; keep
library mounts worker-only and read-only.
