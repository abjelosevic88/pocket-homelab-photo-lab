# Configuration

Environment variables; every one has a default. Personal settings (saving defaults, the editor, connections, AI) live in the UI per person — the `*_URL`/`*_TOKEN`/`OPENAI_*` values below are copied once into the first admin's settings.

| Variable | Default | What |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listen address |
| `BASE_URL` | – | Public URL (links other apps open, the OIDC callback) |
| `DATA_DIR` | `./data` | Database, Core token, backups, pictures |
| `DB_PATH` | `$DATA_DIR/pocket-photolab.db` | SQLite file |
| `IMAGES_DIR` | `$DATA_DIR/images` | Originals and rendered looks, one folder per person |
| `MAX_UPLOAD_BYTES` | `209715200` | Largest picture (200 MB) |
| `MAX_BODY_BYTES` | `67108864` | Largest JSON request, e.g. an export being imported (64 MB) |
| `AUTH_MODE` | `local` | `local` (accounts), `proxy` (trust `AUTH_PROXY_HEADER`/`AUTH_PROXY_EMAIL_HEADER`), `none` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | – | Seed the first admin while the database is empty |
| `SESSION_TTL`, `SECURE_COOKIES` | `720h`, `false` | Set `SECURE_COOKIES=true` behind HTTPS |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME`, `OIDC_AUTO_CREATE` | – | Sign in with an OpenID Connect provider (not needed with Pocket Core) |
| `PHOTOS_URL`, `PHOTOS_TOKEN` | – | Pocket Photos, direct connection (or use Pocket Core) |
| `FILES_URL`, `FILES_TOKEN` | – | Pocket Files, direct connection (or use Pocket Core) |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | – | "Suggest an edit" and "Describe" without Pocket AI (the model must take pictures) |
| `CORE_URL`, `CORE_REGISTRATION_KEY`, `CORE_APP_URL` | – | Pocket Core |
| `TRUST_PROXY`, `METRICS_ENABLED`, `LOG_LEVEL`, `LOG_FORMAT` | `true`, `true`, `info`, `text` | |
| `DEMO_DATA` | `false` | Paint nine landscapes into the owner account, some edited (screenshots, trying it out) |

Commands: `pocket-photolab backup [-o FILE]`, `pocket-photolab reset-password [-email] [-password]`, `pocket-photolab version`.
