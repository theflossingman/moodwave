# 🌊 MoodWave

MoodWave is an AI-powered playlist generator for **Navidrome**.

It connects to your **Navidrome** server and your **local Ollama** server to generate playlists based entirely on your music library.

---

## ✨ Features

- 🎵 Generate playlists using natural language
- 🧠 Uses your own Ollama AI models
- 🎧 Works with your existing Navidrome library
- 📅 Automatic daily AI-generated playlists
- 🔒 Runs completely on your own server

---

## 🗣️ Generate Playlists

Tell the AI anything, and it will build the perfect playlist from **your** music library.

<img width="1919" height="938" alt="Generate Playlist" src="https://github.com/user-attachments/assets/e8f0829d-a179-4950-b4f0-ee41668fc67c" />

---

## 📅 Daily Playlists

Create a new AI-generated playlist every day based on your listening history and existing playlists.

<img width="1919" height="934" alt="Daily Playlist" src="https://github.com/user-attachments/assets/85a3ce01-9404-4faa-bef2-caefe54986aa" />

---

# 🚀 Installation

## Docker Compose

```yaml
services:
  moodwave:
    build: https://github.com/theflossingman/moodwave.git#main
    ports:
      - "9091:3002"
    volumes:
      - /your/path/moodwave:/app/data
    environment:
      TZ: America/New_York
      NODE_ENV: production
      PORT: 3002
    restart: unless-stopped
```

Start the container:

```bash
docker compose up -d
```

---

## 🔑 Default Credentials

| Username | Password |
|----------|----------|
| `admin` | `admin123` |

> **Important:** Change the default password after your first login.
