# Worker

M1 validates immutable configured roots in the worker mount namespace and snapshots their state in
PostgreSQL before pg-boss starts. Discovery is one serial, bounded, read-only pg-boss task per ready
root; keep library mounts worker-only and read-only. Do not add a watcher, reader, or source writes.
