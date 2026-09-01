# DeepSeek Harness Docker (ZimaOS / CasaOS kompatibel)

Produktionsfertiger, Multi-Architektur Docker-Container für **DeepSeek Harness** (`dsh`), gebaut aus dem Fork [`src-one/deepseek-harness`](https://github.com/src-one/deepseek-harness) mit integriertem **schlüssellosen Google-Websuche** Plugin ([`dsh-web-search-playwright`](https://github.com/src-one/dsh-web-search-playwright)).

Speziell optimiert für **ZimaOS**, **CasaOS** und Home-Server-Umgebungen.

---

## ✨ Funktionen

- **Integrierte Google-Websuche**: Enthält das [`dsh-web-search-playwright`](https://github.com/src-one/dsh-web-search-playwright) Plugin für schlüssellose Websuche über ein integriertes Headless Playwright Chromium.
- **Wählbare Modell-Modi**: Basiert auf dem `src-one/deepseek-harness` Fork mit Unterstützung für Modell-Modi und Request-Control-Presets.
- **ZimaOS & LAN-kompatibel**: Integrierter Reverse-Proxy mit `crypto.randomUUID`-Polyfill und Origin-Anpassung, sodass WebSockets und Weboberfläche im lokalen Netzwerk ohne HTTPS-Blockaden funktionieren.
- **Automatische Workspace-Registrierung**: Registriert das gemountete Arbeitsverzeichnis (`DSH_WORKSPACE`) automatisch in der Web-Oberfläche.
- **Multi-Architektur**: Native Unterstützung für `linux/amd64` und `linux/arm64`.
- **Optionale Basic-Authentifizierung**: Schutz der Oberfläche durch `PROXY_USERNAME` und `PROXY_PASSWORD`.

---

## 🚀 Schnellanleitung (Docker Compose)

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
      # DEEPSEEK_API_KEY: dein_api_key_hier
      # PROXY_USERNAME: admin
      # PROXY_PASSWORD: geheimpasswort
      DSH_WORKSPACE: /workspace/Documents
    volumes:
      - /DATA/AppData/dsh-harness:/root/.dsh
      - /DATA/Documents:/workspace/Documents
      - /DATA/Downloads:/workspace/Downloads
      - /DATA/Media:/workspace/Media
      - /DATA/Gallery:/workspace/Gallery
      - /media/ZimaOS-HD:/zimaos
```

Starten mit:
```sh
docker compose up -d
```

Öffne `http://<ZimaOS-IP>:3080` im Browser.

---

## ⚙️ Umgebungsvariablen

| Variable | Standard | Beschreibung |
|---|---|---|
| `PROXY_PORT` | `3080` | Öffentlicher Port des Reverse-Proxys |
| `DSH_PORT` | `3079` | Interner DSH-Daemon-Port |
| `DSH_WORKSPACE` | `/workspace/Documents` | Automatisch registriertes Arbeitsverzeichnis |
| `PROXY_USERNAME` | *(leer)* | Benutzername für HTTP Basic Auth |
| `PROXY_PASSWORD` | *(leer)* | Passwort für HTTP Basic Auth |
| `OPENAI_API_KEY` | *(leer)* | API-Schlüssel für OpenAI / Ollama Modelle |
| `DEEPSEEK_API_KEY` | *(leer)* | API-Schlüssel für DeepSeek API |
| `PLAYWRIGHT_BROWSERS_PATH` | `/opt/ms-playwright` | Speicherort der Chromium-Binärdateien |

---

## 📄 Lizenz

MIT
