# Factum

> An Electron application by [hidders](https://github.com/hidders)

[![Build and Release](https://github.com/hidders/factum/actions/workflows/build.yml/badge.svg)](https://github.com/hidders/factum/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Download

Pre-built installers for all platforms are available on the [Releases](https://github.com/hidders/factum/releases) page.

| Platform | File |
|----------|------|
| macOS (Apple Silicon & Intel) | `Factum-x.x.x-mac-*.dmg` |
| Windows | `Factum-x.x.x-windows-setup.exe` |
| Linux | `Factum-x.x.x-linux-x64.AppImage` or `.deb` |

---

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) v20 or later
- npm v9 or later

### Install dependencies

```bash
npm install
```

### Run in development

```bash
npm start
```

### Build locally

```bash
# All platforms (requires appropriate OS or cross-compile toolchain)
npm run dist

# Per platform
npm run build:mac
npm run build:win
npm run build:linux
```

Build output is written to the `dist/` directory.

---

## Releasing

Releases are automated via GitHub Actions. To publish a new release:

1. Tag a commit following [semver](https://semver.org/):

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. The workflow will build installers for all three platforms and publish them to a GitHub Release automatically.

Pre-release versions (e.g. `v1.0.0-beta.1`) are marked as pre-releases on GitHub.

---

## Code Signing (optional)

To enable code signing and notarization, add the following secrets to your GitHub repository:

**macOS:**
| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` Developer ID certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` file |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |

Without these secrets, macOS builds will be unsigned. Users will need to allow the app via System Settings > Privacy & Security.

**Windows:** Code signing can be added via the `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` secrets using a standard `.p12` certificate.

---

## License

[MIT](LICENSE) © 2026 hidders
