# Config package

Configuration accepts direct development environment variables and `*_FILE` secret paths for
production. `GUTTER_ALLOWED_ROOTS_JSON` is immutable worker configuration and defaults to `[]`;
the library-roots package parses it. Never log a secret value.
