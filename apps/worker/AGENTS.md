# Worker

M2 validates immutable configured roots in the worker mount namespace and snapshots their state in
PostgreSQL before pg-boss starts. Reconciliation is one serial, bounded, read-only pg-boss task per
ready root. Optional chokidar hints are disabled by default, retain no event paths, and only request
a complete root reconciliation; periodic scans remain deletion truth. Keep library mounts worker-only
and read-only. Do not add a reader or source writes.
