# DeepSeek Harness Docker (ZimaOS / CasaOS Compatible)

Production-ready, multi-architecture Docker container for **DeepSeek Harness** (`dsh`), built from [`src-one/deepseek-harness`](https://github.com/src-one/deepseek-harness) with the integrated **Keyless Google Web Search** plugin ([`dsh-web-search-playwright`](https://github.com/src-one/dsh-web-search-playwright)).

Designed specifically for **ZimaOS**, **CasaOS**, and home server environments.

---

## ✨ Features

- **Integrated Google Search**: Built-in [`dsh-web-search-playwright`](https://github.com/src-one/dsh-web-search-playwright) plugin for keyless web searching powered by a headless Playwright Chromium instance.
- **Selectable Model Modes**: Built from the `src-one/deepseek-harness` fork with request-control presets and model mode selection.
- **LAN & ZimaOS Ready**: Built-in reverse proxy with `crypto.randomUUID` polyfill and origin alignment so WebSocket and Web UI features work seamlessly over LAN IPs without HTTPS restrictions.
- **Auto Workspace Registration**: Automatically registers the mounted workspace directory (`DSH_WORKSPACE`) in the web UI.
- **Multi-Architecture**: Native builds for `linux/amd64` and `linux/arm64`.
- **Optional Basic Auth**: Secure your instance behind credentials with `PROXY_USERNAME` and `PROXY_PASSWORD`.

---

## 🚀 Quick Start (Docker Compose)

```yaml
services:
  dsh:
    image: ghcr.io/src-one/deepseek-harness:latest
    container_name: dsh-harness
    restart: unless-stopped
    ports:
      - "3080:3080"
    environment:
      OPENAI_API_KEY: ollama-local-dummy
      # DEEPSEEK_API_KEY: your_key_here
      # PROXY_USERNAME: admin
      # PROXY_PASSWORD: secretpassword
      DSH_WORKSPACE: /workspace/Documents
    volumes:
      - /DATA/AppData/dsh-harness:/root/.dsh
      - /DATA/Documents:/workspace/Documents
      - /DATA/Downloads:/workspace/Downloads
      - /DATA/Media:/workspace/Media
      - /DATA/Gallery:/workspace/Gallery
      - /media/ZimaOS-HD:/zimaos
```

Run:
```sh
docker compose up -d
```

Open `http://<your-server-ip>:3080` in your browser.

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `3080` | External port served by the reverse proxy |
| `DSH_PORT` | `3079` | Internal DSH daemon port |
| `DSH_WORKSPACE` | `/workspace/Documents` | Directory auto-registered into the DSH workspace list |
| `PROXY_USERNAME` | *(none)* | Username for HTTP Basic Auth |
| `PROXY_PASSWORD` | *(none)* | Password for HTTP Basic Auth |
| `OPENAI_API_KEY` | *(none)* | API key for OpenAI / Ollama compatible models |
| `DEEPSEEK_API_KEY` | *(none)* | API key for official DeepSeek API |
| `PLAYWRIGHT_BROWSERS_PATH` | `/opt/ms-playwright` | Path to persistent Chromium browser binaries |

---

## 🛠️ Building Locally

```sh
# Clone repo
git clone https://github.com/src-one/deepseek-harness-docker.git
cd deepseek-harness-docker

# Build container
docker compose build

# Start container
docker compose up -d
```

---

## 📄 License

MIT
